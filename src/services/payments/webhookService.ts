import { createHash } from 'crypto';
import { Op, UniqueConstraintError } from 'sequelize';
import { PaymentAttempt, ProviderEvent } from '../../schemas/index.js';
import type { PaymentProviderName } from '../../schemas/payments/paymentAttemptSchema.js';
import { getDemoProvider, getPaymentProvider, getProviderByName, type PaymentProvider } from '../../modules/payments/index.js';
import { appError } from '../../utils/index.js';
import { describeError, logger } from '../../utils/logger.js';
import { BAD_REQUEST, NOT_FOUND, UNAUTHORIZED } from '../../constants/statusCode.js';
import { fetchAndReconcile } from './reconciliationService.js';

export const MAX_EVENT_ATTEMPTS = 10;

const webhookProvider = (name: PaymentProviderName): PaymentProvider | null => {
  if (name === 'demo') return getDemoProvider();
  const current = getPaymentProvider();
  return current.name === 'busha' ? current : null;
};

// Step 1 (before acknowledging): authenticate against the raw bytes, then store the event durably.
// Busha events have no event id, so the SHA-256 of the exact body is the deduplication key:
// a retried delivery is recognised and stored once.
export const ingestWebhook = async (providerName: PaymentProviderName, rawBody: Buffer, signature: string | undefined, requestId?: string) => {
  const provider = webhookProvider(providerName);
  if (!provider) throw appError(NOT_FOUND, 'webhooks_disabled', 'Webhooks for this provider are not enabled');
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) throw appError(BAD_REQUEST, 'empty_body', 'Empty webhook body');

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    // Nothing from an unauthenticated body is stored or trusted
    logger.warn('Rejected webhook with an invalid signature', { requestId, provider: providerName, bytes: rawBody.length });
    throw appError(UNAUTHORIZED, 'invalid_signature', 'Invalid signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw appError(BAD_REQUEST, 'invalid_json', 'Webhook body is not valid JSON');
  }
  const parsed = provider.parseWebhook(payload);
  const dedupeKey = createHash('sha256').update(rawBody).digest('hex');

  try {
    const event = await ProviderEvent.create({
      provider: providerName,
      dedupeKey,
      eventType: parsed.eventType,
      objectType: parsed.objectType,
      objectId: parsed.objectId?.slice(0, 80) ?? null,
      payload,
      receivedAt: new Date(),
    });
    return { event, duplicate: false };
  } catch (error) {
    if (error instanceof UniqueConstraintError) {
      const event = await ProviderEvent.findOne({ where: { provider: providerName, dedupeKey } });
      return { event: event!, duplicate: true };
    }
    throw error;
  }
};

// Step 2 (after acknowledging, and retried by the reconciler): match the event to a payment attempt and
// confirm its state with an authenticated provider lookup. The event body itself never sets financial state.
export const processProviderEvent = async (eventId: number, requestId?: string) => {
  const event = await ProviderEvent.findByPk(eventId);
  if (!event || event.status === 'processed' || event.status === 'ignored') return event;
  await event.update({ processingAttempts: event.processingAttempts + 1 });

  try {
    const provider = getProviderByName(event.provider);
    if (!provider) {
      await event.update({ status: 'ignored', processedAt: new Date(), lastError: 'Provider not active in this environment' });
      return event;
    }
    const parsed = provider.parseWebhook(event.payload);
    let attempt: PaymentAttempt | null = null;
    if ((parsed.objectType === 'transfer' || parsed.objectType === 'payment_request') && parsed.objectId) {
      attempt = await PaymentAttempt.findOne({ where: { provider: event.provider, providerReference: parsed.objectId } });
    } else if (parsed.objectType === 'deposit' && parsed.accountNumber) {
      // Deposit notifications identify the temporary account; only recent bank-transfer attempts are considered
      attempt = await PaymentAttempt.findOne({
        where: { provider: event.provider, route: 'bank_transfer', payInAccountNumber: parsed.accountNumber, createdAt: { [Op.gt]: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
        order: [['createdAt', 'DESC']],
      });
    }

    if (!attempt) {
      // Kept for audit and reconciliation; it may relate to activity outside Bushustlers checkouts
      await event.update({ status: 'ignored', processedAt: new Date(), lastError: 'No matching payment' });
      return event;
    }

    await fetchAndReconcile(attempt.id, {
      source: 'webhook',
      eventId: event.id,
      requestId,
      depositEvidence: parsed.objectType === 'deposit' ? parsed.depositTotal : null,
    });
    await event.update({ status: 'processed', processedAt: new Date(), paymentAttemptId: attempt.id, lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Processing error';
    logger.warn('Provider event processing failed; will retry', { eventId: event.id, ...describeError(error) });
    // The reconciler retries failed events until MAX_EVENT_ATTEMPTS is reached
    await event.update({ status: 'failed', lastError: message.slice(0, 255) });
  }
  return event;
};

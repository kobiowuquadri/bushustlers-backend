import { Op, type WhereOptions } from 'sequelize';
import sequelize from '../../database/db.js';
import { config } from '../../config/config.js';
import { AuditEvent, Order, PaymentAttempt, PaymentLink, ProviderEvent, Settlement, type Business } from '../../schemas/index.js';
import { BushaProvider, getDemoProvider, getPaymentProvider, ProviderError, type DemoOutcome } from '../../modules/payments/index.js';
import { appError, getPagination, messageHandler, paginate } from '../../utils/index.js';
import { CONFLICT, FORBIDDEN, NOT_FOUND, SERVICE_UNAVAILABLE, SUCCESS } from '../../constants/statusCode.js';
import { recordAudit } from '../audit/auditService.js';
import { describeAuditEvent } from '../audit/auditText.js';
import { escapeLike } from '../commerce/customerService.js';
import { serializeAttempt, serializeSettlement } from '../serializers.js';
import { createSettlement, fetchAndReconcile, recomputeOrderPayment } from './reconciliationService.js';
import { ingestWebhook, processProviderEvent } from './webhookService.js';

const findOwnedAttempt = async (businessId: number, attemptPublicId: string) => {
  const attempt = await PaymentAttempt.findOne({ where: { publicId: attemptPublicId, businessId } });
  if (!attempt) throw appError(NOT_FOUND, 'payment_not_found', 'Payment not found');
  return attempt;
};

export const listTransactionsService = async (business: Business, query: { status?: string; route?: string; search?: string; page?: unknown; limit?: unknown }) => {
  const { page, limit, offset } = getPagination(query, 20, 100);
  const conditions: WhereOptions[] = [{ businessId: business.id }, { status: { [Op.ne]: 'creating' } }];
  if (query.status) conditions.push({ status: query.status });
  if (query.route) conditions.push({ route: query.route });
  const search = query.search?.trim();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    conditions.push({ [Op.or]: [{ reference: { [Op.like]: like } }, { providerReference: { [Op.like]: like } }, { '$order.reference$': { [Op.like]: like } }] });
  }
  const result = await PaymentAttempt.findAndCountAll({
    where: { [Op.and]: conditions },
    include: [{ model: Order, as: 'order', attributes: ['id', 'publicId', 'reference'] }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
    subQuery: false,
  });
  const settlements = result.rows.length ? await Settlement.findAll({ where: { paymentAttemptId: { [Op.in]: result.rows.map((a) => a.id) } } }) : [];
  const { pagination } = paginate(result, page, limit);
  return messageHandler('Transactions retrieved', true, SUCCESS, {
    items: result.rows.map((attempt) => {
      const order = (attempt as PaymentAttempt & { order?: Order }).order;
      return serializeAttempt(attempt, { order, settlement: settlements.find((s) => s.paymentAttemptId === attempt.id) });
    }),
    pagination,
  });
};

export const loadTransactionDetail = async (business: Business, attemptPublicId: string) => {
  const attempt = await findOwnedAttempt(business.id, attemptPublicId);
  const [order, settlement, events, providerEvents, link] = await Promise.all([
    Order.findByPk(attempt.orderId),
    Settlement.findOne({ where: { paymentAttemptId: attempt.id } }),
    AuditEvent.findAll({
      where: { businessId: business.id, [Op.or]: [{ entityType: 'payment_attempt', entityId: attempt.id }] },
      order: [['createdAt', 'ASC'], ['id', 'ASC']],
    }),
    ProviderEvent.findAll({ where: { paymentAttemptId: attempt.id }, order: [['receivedAt', 'ASC']], attributes: ['eventType', 'status', 'receivedAt', 'processedAt'] }),
    PaymentLink.findByPk(attempt.paymentLinkId),
  ]);
  const demoTools = config.payments.demoToolsEnabled;
  return {
    ...serializeAttempt(attempt, { order, settlement }),
    linkId: link?.publicId ?? null,
    settlement: settlement ? serializeSettlement(settlement, { order, attempt }) : null,
    events: events.map(describeAuditEvent),
    providerEvents: providerEvents.map((e) => ({ eventType: e.eventType, status: e.status, receivedAt: e.receivedAt, processedAt: e.processedAt })),
    failureReason: attempt.status === 'failed' ? 'The provider could not complete this payment or its setup.' : null,
    actions: {
      canRefresh: Boolean(attempt.providerReference) && !['failed'].includes(attempt.status),
      canResolve: attempt.status === 'needs_review' || (attempt.status === 'confirmed' && Boolean(attempt.reviewReason) && !attempt.reviewResolution),
      canSimulate:
        demoTools &&
        ['awaiting_payment', 'processing'].includes(attempt.status) &&
        ((attempt.provider === 'demo' && Boolean(getDemoProvider())) || (attempt.provider === 'busha' && attempt.providerMode === 'sandbox' && attempt.route === 'bank_transfer')),
      simulationKind: attempt.provider === 'demo' ? 'demo' : attempt.providerMode === 'sandbox' ? 'busha_sandbox' : null,
    },
  };
};

export const getTransactionService = async (business: Business, attemptPublicId: string) =>
  messageHandler('Transaction retrieved', true, SUCCESS, { transaction: await loadTransactionDetail(business, attemptPublicId) });

export const refreshTransactionService = async (business: Business, attemptPublicId: string, requestId?: string) => {
  const attempt = await findOwnedAttempt(business.id, attemptPublicId);
  if (attempt.providerReference && !(attempt.lastCheckedAt && Date.now() - attempt.lastCheckedAt.getTime() < 5_000)) {
    try {
      await fetchAndReconcile(attempt.id, { source: 'merchant_refresh', requestId });
    } catch (error) {
      if (error instanceof ProviderError) throw appError(SERVICE_UNAVAILABLE, 'provider_unavailable', "We couldn't reach the payment provider. Nothing has changed; try again shortly.");
      throw error;
    }
  }
  return messageHandler('Status checked with the provider', true, SUCCESS, { transaction: await loadTransactionDetail(business, attemptPublicId) });
};

// A merchant decision on a payment held for review. "accept" confirms money the provider reported as
// received (e.g. an underpayment the merchant is happy with); "hold" records a note and keeps it on hold.
// No refunds are initiated here.
export const resolveReviewService = async (business: Business, attemptPublicId: string, input: { decision: 'accept' | 'hold'; note?: string }, userId: number, requestId?: string) => {
  const owned = await findOwnedAttempt(business.id, attemptPublicId);
  await sequelize.transaction(async (transaction) => {
    const attempt = await PaymentAttempt.findByPk(owned.id, { transaction, lock: transaction.LOCK.UPDATE });
    const order = attempt ? await Order.findByPk(attempt.orderId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (!attempt || !order) throw appError(NOT_FOUND, 'payment_not_found', 'Payment not found');
    const actor = { type: 'user' as const, id: userId };
    const flaggedConfirmed = attempt.status === 'confirmed' && attempt.reviewReason && !attempt.reviewResolution;
    if (attempt.status !== 'needs_review' && !flaggedConfirmed) throw appError(CONFLICT, 'not_in_review', 'This payment is not waiting for a review decision');

    if (input.decision === 'hold') {
      await attempt.update({ resolutionNote: input.note || null }, { transaction });
      await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.review_note', actor, metadata: input.note ? { note: input.note } : null, requestId }, transaction);
      return;
    }

    if (attempt.status === 'needs_review') {
      if (attempt.receivedAmountMinor === null) {
        throw appError(CONFLICT, 'amount_unknown', 'The provider has not reported a received amount for this payment yet. Check its status first.');
      }
      await attempt.update({ status: 'confirmed', confirmedAt: new Date(), reviewResolution: 'accepted', resolvedAt: new Date(), resolvedBy: userId, resolutionNote: input.note || null }, { transaction });
      await createSettlement(attempt, transaction, actor, requestId);
      await PaymentLink.update({ status: 'completed', completedAt: new Date() }, { where: { id: attempt.paymentLinkId, status: { [Op.in]: ['active', 'expired', 'disabled'] } }, transaction });
    } else {
      await attempt.update({ reviewResolution: 'accepted', resolvedAt: new Date(), resolvedBy: userId, resolutionNote: input.note || null }, { transaction });
    }
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.resolved', actor, fromStatus: 'needs_review', toStatus: 'confirmed', metadata: input.note ? { note: input.note } : null, requestId }, transaction);
    await recomputeOrderPayment(order, transaction, actor, requestId);
  });
  return messageHandler(input.decision === 'accept' ? 'Payment accepted' : 'Note saved; payment kept on hold', true, SUCCESS, { transaction: await loadTransactionDetail(business, attemptPublicId) });
};

// Merchant-side testing tools. Never available in production and never on the public checkout.
// Demo mode: the demo provider changes its record and emits a signed notification through the normal webhook pipeline.
// Busha sandbox: calls Busha's documented simulate-deposit endpoint for a bank-transfer payment.
export const simulatePaymentService = async (business: Business, attemptPublicId: string, outcome: DemoOutcome, requestId?: string) => {
  if (!config.payments.demoToolsEnabled) throw appError(FORBIDDEN, 'demo_tools_disabled', 'Payment simulation is not available in this environment');
  const attempt = await findOwnedAttempt(business.id, attemptPublicId);
  if (!attempt.providerReference || !['awaiting_payment', 'processing'].includes(attempt.status)) {
    throw appError(CONFLICT, 'not_simulatable', 'Only payments that are awaiting payment or processing can be simulated');
  }

  if (attempt.provider === 'demo') {
    const demo = getDemoProvider();
    if (!demo) throw appError(FORBIDDEN, 'demo_tools_disabled', 'Demo simulation is not available');
    const { rawBody, signature } = await demo.simulate(attempt.providerReference, outcome);
    const { event } = await ingestWebhook('demo', rawBody, signature, requestId);
    await processProviderEvent(event.id, requestId);
  } else {
    const provider = getPaymentProvider();
    if (!(provider instanceof BushaProvider) || provider.mode !== 'sandbox' || attempt.route !== 'bank_transfer') {
      throw appError(CONFLICT, 'not_simulatable', 'Busha sandbox simulation is only documented for bank-transfer deposits');
    }
    if (outcome !== 'paid' && outcome !== 'failed') throw appError(CONFLICT, 'not_simulatable', 'The Busha sandbox can simulate a completed or failed deposit only');
    try {
      await provider.simulateDeposit(attempt.providerReference, outcome === 'paid' ? 'completed' : 'failed');
      // Busha also sends webhooks; this immediate lookup just avoids waiting for them
      await fetchAndReconcile(attempt.id, { source: 'merchant_refresh', requestId });
    } catch (error) {
      if (error instanceof ProviderError) throw appError(SERVICE_UNAVAILABLE, 'provider_unavailable', `Busha sandbox: ${error.message}`);
      throw error;
    }
  }
  return messageHandler('Simulation sent', true, SUCCESS, { transaction: await loadTransactionDetail(business, attemptPublicId) });
};

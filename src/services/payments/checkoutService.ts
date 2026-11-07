import { Op } from 'sequelize';
import sequelize from '../../database/db.js';
import { Business, Customer, Order, OrderItem, PaymentAttempt, PaymentLink } from '../../schemas/index.js';
import type { PaymentRoute } from '../../schemas/payments/paymentAttemptSchema.js';
import { getPaymentProvider, ProviderError } from '../../modules/payments/index.js';
import { appError, attemptReference, messageHandler, publicId, toMinor } from '../../utils/index.js';
import { describeError, logger } from '../../utils/logger.js';
import { CONFLICT, CREATED, NOT_FOUND, SERVICE_UNAVAILABLE, SUCCESS, VALIDATION_ERROR } from '../../constants/statusCode.js';
import { recordAudit } from '../audit/auditService.js';
import { effectiveLinkStatus, routeLabel, serializeItem } from '../serializers.js';
import { fetchAndReconcile } from './reconciliationService.js';
import { expirePaymentLink } from './expiryService.js';

const GONE = 410;
const BAD_GATEWAY = 502;
const REFRESH_THROTTLE_MS = 10_000;

// Buyer-facing wording: plain, no promises about refunds or timings
const BUYER_STATUS_TEXT: Record<string, string> = {
  creating: 'Getting your payment details ready…',
  awaiting_payment: 'Waiting for your payment.',
  processing: 'Payment detected. Confirming it with the payment provider…',
  confirmed: 'Payment confirmed. The seller has been notified.',
  needs_review: 'Your payment was received but needs a check by the seller before the order is confirmed. The seller will contact you.',
  failed: 'The payment provider reported that this payment did not go through.',
  expired: 'These payment details have expired. Choose a payment method to get new details.',
  cancelled: 'These payment details are no longer active.',
};

export interface StartPaymentInput {
  route: PaymentRoute;
  asset?: string;
  network?: string;
  email?: string;
  name?: string;
}

const loadLink = async (linkPublicId: string) => {
  let link = await PaymentLink.findOne({ where: { publicId: linkPublicId } });
  if (!link) throw appError(NOT_FOUND, 'link_not_found', "This payment link doesn't exist. Check the link with the seller.");
  if (link.status === 'active' && link.expiresAt.getTime() < Date.now()) {
    await expirePaymentLink(link.id);
    link = (await PaymentLink.findByPk(link.id))!;
  }
  return link;
};

const buyerAttempt = (attempt: PaymentAttempt) => ({
  id: attempt.publicId,
  route: attempt.route,
  routeLabel: routeLabel(attempt),
  status: attempt.status,
  statusText: BUYER_STATUS_TEXT[attempt.status],
  // Instructions are only shown while they can still be used
  instructions: attempt.status === 'awaiting_payment' || attempt.status === 'processing' ? attempt.instructions : null,
  asset: attempt.asset,
  network: attempt.network,
  assetAmount: attempt.assetAmount,
  rate: attempt.rate,
  rateSource: attempt.rateSource,
  providerFees: attempt.providerFees ?? [],
  expiresAt: attempt.expiresAt,
  confirmedAt: attempt.confirmedAt,
  createdAt: attempt.createdAt,
  lastCheckedAt: attempt.lastCheckedAt,
});

const buildCheckoutView = async (link: PaymentLink) => {
  const [order, business, attempts] = await Promise.all([
    Order.findByPk(link.orderId, { include: [{ model: OrderItem, as: 'items' }, { model: Customer, as: 'customer' }], order: [[{ model: OrderItem, as: 'items' }, 'position', 'ASC']] }),
    Business.findByPk(link.businessId),
    PaymentAttempt.findAll({ where: { paymentLinkId: link.id }, order: [['createdAt', 'DESC']], limit: 10 }),
  ]);
  if (!order || !business) throw appError(NOT_FOUND, 'link_not_found', "This payment link doesn't exist. Check the link with the seller.");
  const provider = getPaymentProvider();
  const stablecoinOptions = provider.stablecoinOptions();
  const linkStatus = effectiveLinkStatus(link);

  return {
    link: { id: link.publicId, status: linkStatus, expiresAt: link.expiresAt },
    merchant: { name: business.name },
    order: {
      reference: order.reference,
      currency: order.currency,
      items: (order.items || []).map(serializeItem),
      subtotalMinor: String(order.subtotalMinor),
      deliveryFeeMinor: String(order.deliveryFeeMinor),
      totalMinor: String(order.totalMinor),
      paymentStatus: order.paymentStatus,
      cancelled: order.status === 'cancelled',
      paidAt: order.paidAt,
      buyerEmail: order.customer?.email ?? null,
    },
    methods: {
      bankTransfer: { available: provider.capabilities.bankTransfer },
      stablecoin: { available: provider.capabilities.stablecoin && stablecoinOptions.length > 0, options: stablecoinOptions },
    },
    payments: attempts.filter((a) => a.status !== 'creating' || Date.now() - a.createdAt.getTime() < 60_000).map(buyerAttempt),
    mode: provider.mode,
    receiptAvailable: order.paymentStatus === 'paid',
  };
};

export const getCheckoutService = async (linkPublicId: string) => {
  const link = await loadLink(linkPublicId);
  return messageHandler('Checkout retrieved', true, SUCCESS, { checkout: await buildCheckoutView(link) });
};

export const startPaymentService = async (linkPublicId: string, input: StartPaymentInput, idempotencyKey: string, requestId?: string) => {
  const linkRef = await loadLink(linkPublicId);
  const provider = getPaymentProvider();

  // Phase 1 (short transaction, link and order rows locked): idempotency, eligibility, and a "creating" record.
  const { attemptId, created } = await sequelize.transaction(async (transaction) => {
    const link = await PaymentLink.findByPk(linkRef.id, { transaction, lock: transaction.LOCK.UPDATE });
    const order = link ? await Order.findByPk(link.orderId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    if (!link || !order) throw appError(NOT_FOUND, 'link_not_found', "This payment link doesn't exist.");

    // Same idempotency key => same attempt, however many times the request is repeated
    const replay = await PaymentAttempt.findOne({ where: { paymentLinkId: link.id, idempotencyKey }, transaction });
    if (replay) return { attemptId: replay.id, created: false };

    const status = effectiveLinkStatus(link);
    if (status === 'completed' || order.paymentStatus === 'paid') throw appError(CONFLICT, 'already_paid', 'This order has already been paid.');
    if (status !== 'active' || order.status === 'cancelled') {
      throw appError(GONE, `link_${status === 'active' ? 'disabled' : status}`, status === 'expired' ? 'This payment link has expired. Ask the seller for a new link.' : 'This payment link is no longer active. Ask the seller for a new link.');
    }
    if (order.paymentStatus === 'processing' || order.paymentStatus === 'needs_review') {
      throw appError(CONFLICT, 'payment_in_progress', 'A payment for this order is already being processed. Check its status below.');
    }

    if (input.route === 'bank_transfer' && !provider.capabilities.bankTransfer) throw appError(CONFLICT, 'method_unavailable', 'Bank transfer is not available right now.');
    if (input.route === 'stablecoin' && !provider.stablecoinOptions().some((o) => o.asset === input.asset && o.network === input.network)) {
      throw appError(CONFLICT, 'method_unavailable', 'That stablecoin and network are not available for this checkout.');
    }
    // The provider requires a contact email for stablecoin payment requests
    if (input.route === 'stablecoin' && !input.email) {
      const customer = order.customerId ? await Customer.findByPk(order.customerId, { transaction }) : null;
      if (!customer?.email) {
        throw appError(VALIDATION_ERROR, 'email_required', 'Enter your email address to pay with a stablecoin', { errors: [{ field: 'email', message: 'Enter your email address' }] });
      }
    }

    // Repeated initiation for the same method reuses instructions that are still valid
    const reusable = await PaymentAttempt.findOne({
      where: {
        paymentLinkId: link.id,
        route: input.route,
        asset: input.route === 'stablecoin' ? input.asset! : null,
        network: input.route === 'stablecoin' ? input.network! : null,
        status: 'awaiting_payment',
        expiresAt: { [Op.gt]: new Date(Date.now() + 2 * 60 * 1000) },
      },
      order: [['createdAt', 'DESC']],
      transaction,
    });
    if (reusable) return { attemptId: reusable.id, created: false };

    const inFlight = await PaymentAttempt.findOne({ where: { paymentLinkId: link.id, status: 'creating', createdAt: { [Op.gt]: new Date(Date.now() - 30_000) } }, transaction });
    if (inFlight) throw appError(CONFLICT, 'payment_setup_in_progress', "We're still preparing your payment details. Try again in a few seconds.");

    const attempt = await PaymentAttempt.create(
      {
        publicId: publicId('pat'),
        businessId: link.businessId,
        orderId: order.id,
        paymentLinkId: link.id,
        route: input.route,
        provider: provider.name,
        providerMode: provider.mode,
        reference: attemptReference(order.reference),
        idempotencyKey,
        expectedAmountMinor: String(order.totalMinor),
        asset: input.route === 'stablecoin' ? input.asset! : null,
        network: input.route === 'stablecoin' ? input.network! : null,
        buyerEmail: input.email || null,
        buyerName: input.name || null,
      },
      { transaction },
    );
    await recordAudit({ businessId: link.businessId, orderId: order.id, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.started', actor: { type: 'buyer' }, toStatus: 'creating', metadata: { route: input.route, asset: input.asset, network: input.network }, requestId }, transaction);
    return { attemptId: attempt.id, created: true };
  });

  // Phase 2: the provider call runs outside any database transaction so no rows stay locked during network I/O.
  if (created) {
    const attempt = (await PaymentAttempt.findByPk(attemptId))!;
    const order = (await Order.findByPk(attempt.orderId, { include: [{ model: Customer, as: 'customer' }] }))!;
    try {
      const collection = await provider.createCollection({
        reference: attempt.reference,
        route: attempt.route,
        amountMinor: toMinor(attempt.expectedAmountMinor),
        asset: attempt.asset ?? undefined,
        network: attempt.network ?? undefined,
        buyer: { email: input.email || order.customer?.email || null, name: input.name || order.customer?.name || null, phone: order.customer?.phone || null },
      });
      await sequelize.transaction(async (transaction) => {
        await attempt.update(
          {
            providerReference: collection.providerReference,
            providerStatus: collection.providerStatus,
            status: 'awaiting_payment',
            instructions: collection.instructions,
            expiresAt: collection.expiresAt,
            assetAmount: collection.assetAmount,
            rate: collection.rate,
            rateSource: collection.rateSource,
            providerFees: collection.fees,
            settlementAmount: collection.settlement?.amount ?? null,
            settlementCurrency: collection.settlement?.currency ?? null,
            payInAccountNumber: collection.instructions.kind === 'bank_transfer' ? collection.instructions.accountNumber.slice(0, 20) : null,
          },
          { transaction },
        );
        await recordAudit({ businessId: attempt.businessId, orderId: attempt.orderId, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.awaiting', actor: { type: 'provider' }, fromStatus: 'creating', toStatus: 'awaiting_payment', metadata: { route: attempt.route, asset: attempt.asset, network: attempt.network }, requestId }, transaction);
      });
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      if (providerError) {
        logger.warn('Payment provider setup failed', { requestId, provider: provider.name, mode: provider.mode, route: attempt.route, kind: providerError.kind, httpStatus: providerError.httpStatus });
      } else {
        logger.error('Payment setup failed', { requestId, ...describeError(error) });
      }
      await attempt.update({ status: 'failed', failedAt: new Date(), failureReason: providerError ? `${providerError.kind}: ${providerError.message}`.slice(0, 255) : 'Unexpected error' });
      await recordAudit({ businessId: attempt.businessId, orderId: attempt.orderId, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.setup_failed', actor: { type: 'provider' }, fromStatus: 'creating', toStatus: 'failed', metadata: { kind: providerError?.kind ?? 'unexpected' }, requestId });
      if (providerError?.kind === 'rejected') {
        throw appError(BAD_GATEWAY, 'provider_rejected', "We couldn't set up this payment method right now. Try another method or try again later.");
      }
      throw appError(SERVICE_UNAVAILABLE, 'provider_unavailable', 'The payment provider is temporarily unavailable. Please try again in a moment.');
    }
  }

  const attempt = (await PaymentAttempt.findByPk(attemptId))!;
  const link = (await PaymentLink.findByPk(linkRef.id))!;
  return messageHandler(created ? 'Payment details ready' : 'Payment details retrieved', true, created ? CREATED : SUCCESS, {
    payment: buyerAttempt(attempt),
    checkout: await buildCheckoutView(link),
  });
};

const findLinkAttempt = async (linkPublicId: string, attemptPublicId: string) => {
  const link = await loadLink(linkPublicId);
  const attempt = await PaymentAttempt.findOne({ where: { publicId: attemptPublicId, paymentLinkId: link.id } });
  if (!attempt) throw appError(NOT_FOUND, 'payment_not_found', 'Payment not found');
  return { link, attempt };
};

// "Check payment status": asks the provider for the current state. It never marks anything paid by itself;
// only the reconciliation service can, after verifying the provider's answer.
export const refreshPaymentService = async (linkPublicId: string, attemptPublicId: string, requestId?: string) => {
  const { link, attempt } = await findLinkAttempt(linkPublicId, attemptPublicId);
  const recentlyChecked = attempt.lastCheckedAt && Date.now() - attempt.lastCheckedAt.getTime() < REFRESH_THROTTLE_MS;
  if (attempt.providerReference && !recentlyChecked && !['failed'].includes(attempt.status)) {
    try {
      await fetchAndReconcile(attempt.id, { source: 'buyer_refresh', requestId });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw appError(SERVICE_UNAVAILABLE, 'provider_unavailable', "We couldn't reach the payment provider just now. Your payment is safe; try checking again in a minute.");
      }
      throw error;
    }
  }
  const fresh = (await PaymentAttempt.findByPk(attempt.id))!;
  return messageHandler('Payment status checked', true, SUCCESS, { payment: buyerAttempt(fresh), checkout: await buildCheckoutView(link) });
};

export const getReceiptService = async (linkPublicId: string) => {
  const link = await loadLink(linkPublicId);
  const order = await Order.findByPk(link.orderId, { include: [{ model: OrderItem, as: 'items' }], order: [[{ model: OrderItem, as: 'items' }, 'position', 'ASC']] });
  if (!order || order.paymentStatus !== 'paid') throw appError(NOT_FOUND, 'receipt_unavailable', 'A receipt is available once the payment is confirmed.');
  return messageHandler('Receipt retrieved', true, SUCCESS, { receipt: await buildReceipt(order) });
};

export const buildReceipt = async (order: Order) => {
  const [business, confirmed] = await Promise.all([
    Business.findByPk(order.businessId),
    PaymentAttempt.findAll({ where: { orderId: order.id, status: 'confirmed' }, order: [['confirmedAt', 'ASC']] }),
  ]);
  return {
    receiptNumber: `RCP-${order.reference}`,
    merchant: { name: business?.name ?? '' },
    order: {
      reference: order.reference,
      currency: order.currency,
      items: (order.items || []).map(serializeItem),
      subtotalMinor: String(order.subtotalMinor),
      deliveryFeeMinor: String(order.deliveryFeeMinor),
      totalMinor: String(order.totalMinor),
    },
    amountPaidMinor: String(order.amountPaidMinor),
    paidAt: order.paidAt,
    payments: confirmed.map((attempt) => ({
      id: attempt.publicId,
      routeLabel: routeLabel(attempt),
      amountMinor: String(attempt.receivedAmountMinor ?? attempt.expectedAmountMinor),
      asset: attempt.asset,
      network: attempt.network,
      assetAmount: attempt.receivedAmount && attempt.route === 'stablecoin' ? attempt.receivedAmount : attempt.assetAmount,
      // Partial provider reference is enough for support without exposing the whole identifier
      providerReference: attempt.providerReference ? `…${attempt.providerReference.slice(-8)}` : null,
      confirmedAt: attempt.confirmedAt,
      mode: attempt.providerMode,
    })),
  };
};

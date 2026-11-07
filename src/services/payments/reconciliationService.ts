import { Op, type Transaction } from 'sequelize';
import sequelize from '../../database/db.js';
import { config } from '../../config/config.js';
import { REVIEW_REASON_TEXT } from '../../constants/payments.js';
import { Auth, Business, BusinessMember, Customer, Order, PaymentAttempt, PaymentLink, Settlement } from '../../schemas/index.js';
import type { AttemptStatus, ReviewReason } from '../../schemas/payments/paymentAttemptSchema.js';
import { getProviderByName, type Amount, type ProviderPaymentState } from '../../modules/payments/index.js';
import { sendMail } from '../../modules/notifications/mailer.js';
import { basisPointsOf, compareDecimal, divideDecimal, formatNaira, majorToMinor, minorToMajor, publicId, toMinor } from '../../utils/index.js';
import { describeError, logger } from '../../utils/logger.js';
import { recordAudit, type Actor } from '../audit/auditService.js';
import { routeLabel } from '../serializers.js';

export type CheckSource = 'webhook' | 'buyer_refresh' | 'merchant_refresh' | 'reconciler' | 'simulation';

export interface ReconcileContext {
  source: CheckSource;
  requestId?: string;
  eventId?: number;
  // Amount reported by a signed deposit notification for a bank-transfer account
  depositEvidence?: Amount | null;
}

const OPEN: AttemptStatus[] = ['creating', 'awaiting_payment'];
const CLOSED: AttemptStatus[] = ['expired', 'cancelled', 'failed'];
const FUNDS_SEEN = ['processing', 'succeeded', 'underpaid', 'overpaid', 'multiple_deposits'];

interface Decision {
  next: AttemptStatus;
  reviewReason?: ReviewReason;
  // A post-confirmation anomaly: the attempt stays confirmed but the order is flagged for review
  flag?: ReviewReason;
}

type AttemptSnapshot = Pick<
  PaymentAttempt,
  'status' | 'route' | 'reference' | 'expectedAmountMinor' | 'asset' | 'assetAmount' | 'receivedAmountMinor'
>;

// Compares what the provider reports with what this attempt asked for. Returns a review reason or null.
export const amountProblem = (attempt: AttemptSnapshot, state: ProviderPaymentState): ReviewReason | null => {
  if (state.reference && state.reference !== attempt.reference) return 'reference_mismatch';
  const expected = toMinor(attempt.expectedAmountMinor);
  const expectedMajor = minorToMajor(expected);

  if (state.requested) {
    if (state.requested.currency !== 'NGN') return 'currency_mismatch';
    if (compareDecimal(state.requested.amount, expectedMajor) !== 0) return 'reference_mismatch';
  }

  if (attempt.route === 'bank_transfer') {
    if (!state.paid) return 'reference_mismatch';
    if (state.paid.currency !== 'NGN') return 'currency_mismatch';
    const reported = compareDecimal(state.paid.amount, expectedMajor);
    if (reported < 0) return 'underpayment';
    if (reported > 0) return 'overpayment';
    // A signed deposit notification for this account takes precedence over the quoted amount
    if (attempt.receivedAmountMinor !== null && attempt.receivedAmountMinor !== undefined) {
      const received = toMinor(attempt.receivedAmountMinor);
      if (received < expected) return 'underpayment';
      if (received > expected) return 'overpayment';
    }
    return null;
  }

  if (!state.paid || state.paid.currency !== attempt.asset) return 'currency_mismatch';
  if (attempt.assetAmount) {
    const cmp = compareDecimal(state.paid.amount, attempt.assetAmount);
    if (cmp < 0) return 'underpayment';
    if (cmp > 0) return 'overpayment';
  }
  return null;
};

// Pure state machine. Statuses only move forward: a confirmed payment is never downgraded by a late
// "pending" event, and funds arriving after instructions closed always become an explicit review case.
export const decideTransition = (attempt: AttemptSnapshot, state: ProviderPaymentState, orderAlreadyPaidByOther: boolean): Decision | null => {
  const current = attempt.status;
  if (current === 'confirmed') {
    if (state.status === 'overpaid') return { next: 'confirmed', flag: 'overpayment' };
    if (state.status === 'multiple_deposits') return { next: 'confirmed', flag: 'multiple_deposits' };
    return null;
  }
  if (current === 'needs_review') return null;
  const closed = CLOSED.includes(current);

  switch (state.status) {
    case 'pending':
      return current === 'creating' ? { next: 'awaiting_payment' } : null;
    case 'processing':
      if (OPEN.includes(current)) return { next: 'processing' };
      if (closed) return { next: 'needs_review', reviewReason: 'late_payment' };
      return null;
    case 'succeeded': {
      const problem = amountProblem(attempt, state);
      if (problem) return { next: 'needs_review', reviewReason: problem };
      if (closed) return { next: 'needs_review', reviewReason: 'late_payment' };
      if (orderAlreadyPaidByOther) return { next: 'needs_review', reviewReason: 'duplicate_payment' };
      return { next: 'confirmed' };
    }
    case 'underpaid':
      return { next: 'needs_review', reviewReason: 'underpayment' };
    case 'overpaid':
      return { next: 'needs_review', reviewReason: 'overpayment' };
    case 'multiple_deposits':
      return { next: 'needs_review', reviewReason: 'multiple_deposits' };
    case 'failed':
      return OPEN.includes(current) || current === 'processing' ? { next: 'failed' } : null;
    case 'expired':
      return OPEN.includes(current) ? { next: 'expired' } : null;
    case 'cancelled':
      return OPEN.includes(current) ? { next: 'cancelled' } : null;
    default:
      return null;
  }
};

// NGN value of what the buyer paid, used for order totals and fee basis.
const ngnEquivalentMinor = (attempt: PaymentAttempt, state: ProviderPaymentState | null): bigint | null => {
  if (attempt.route === 'bank_transfer') {
    return attempt.receivedCurrency === 'NGN' && attempt.receivedAmount ? majorToMinor(attempt.receivedAmount) : null;
  }
  if (state?.status === 'succeeded') return toMinor(attempt.expectedAmountMinor);
  if (attempt.receivedAmount && attempt.assetAmount && attempt.receivedCurrency === attempt.asset) {
    // Proportional to the quoted amount, e.g. 26.67 of 30.00 USDT => 8/9 of the order total
    const ratioMajor = divideDecimal(
      (BigInt(majorToMinor(attempt.receivedAmount, 6)) * toMinor(attempt.expectedAmountMinor)).toString(),
      majorToMinor(attempt.assetAmount, 6).toString(),
      0,
    );
    return BigInt(ratioMajor);
  }
  if (attempt.settlementCurrency === 'NGN' && attempt.settlementAmount) return majorToMinor(attempt.settlementAmount);
  return null;
};

export const feeBasisText = (route: 'bank_transfer' | 'stablecoin') =>
  route === 'stablecoin'
    ? `${config.fees.stablecoinBps / 100}% per stablecoin checkout (proposed pricing)`
    : `${config.fees.ngnBps / 100}% per verified naira payment, capped at ${formatNaira(BigInt(config.fees.ngnCapMinor))} (proposed pricing)`;

export const platformFeeFor = (route: 'bank_transfer' | 'stablecoin', grossMinor: bigint) =>
  route === 'stablecoin' ? basisPointsOf(grossMinor, config.fees.stablecoinBps) : basisPointsOf(grossMinor, config.fees.ngnBps, config.fees.ngnCapMinor);

const createSettlement = async (attempt: PaymentAttempt, transaction: Transaction, actor: Actor, requestId?: string) => {
  const existing = await Settlement.findOne({ where: { paymentAttemptId: attempt.id }, transaction });
  if (existing) return existing;
  const gross = toMinor(attempt.receivedAmountMinor ?? attempt.expectedAmountMinor);
  const credited = attempt.settlementCurrency === 'NGN' && attempt.settlementAmount ? majorToMinor(attempt.settlementAmount) : null;
  const reportedFees = (attempt.providerFees || []).filter((fee) => fee.currency === 'NGN').reduce((sum, fee) => sum + majorToMinor(fee.amount), 0n);
  const providerFee = credited !== null && credited <= gross ? gross - credited : reportedFees;
  const platformFee = platformFeeFor(attempt.route, gross);
  const net = (credited ?? gross - providerFee) - platformFee;
  const settlement = await Settlement.create(
    {
      publicId: publicId('stl'),
      businessId: attempt.businessId,
      orderId: attempt.orderId,
      paymentAttemptId: attempt.id,
      grossMinor: gross.toString(),
      providerFeeMinor: providerFee.toString(),
      platformFeeMinor: platformFee.toString(),
      netMinor: (net > 0n ? net : 0n).toString(),
      feeBasis: feeBasisText(attempt.route),
      simulated: attempt.provider === 'demo',
    },
    { transaction },
  );
  await recordAudit({ businessId: attempt.businessId, orderId: attempt.orderId, entityType: 'settlement', entityId: settlement.id, action: 'settlement.created', actor, toStatus: 'pending', requestId }, transaction);
  return settlement;
};

// Re-derives the order's payment status from all of its attempts.
export const recomputeOrderPayment = async (order: Order, transaction: Transaction, actor: Actor, requestId?: string) => {
  const attempts = await PaymentAttempt.findAll({ where: { orderId: order.id }, transaction });
  const confirmed = attempts.filter((a) => a.status === 'confirmed');
  const inReview = attempts.some((a) => a.status === 'needs_review');
  const flagged = confirmed.some((a) => a.reviewReason && !a.reviewResolution);
  const processing = attempts.some((a) => a.status === 'processing');
  const paymentStatus = confirmed.length ? 'paid' : inReview ? 'needs_review' : processing ? 'processing' : 'unpaid';
  const amountPaid = confirmed.reduce((sum, a) => sum + toMinor(a.receivedAmountMinor ?? a.expectedAmountMinor), 0n);
  const from = order.paymentStatus;

  await order.update(
    {
      paymentStatus,
      amountPaidMinor: amountPaid.toString(),
      reviewRequired: confirmed.length > 0 && (inReview || flagged),
      paidAt: paymentStatus === 'paid' ? order.paidAt ?? new Date() : order.paidAt,
    },
    { transaction },
  );
  if (from !== paymentStatus) {
    await recordAudit({ businessId: order.businessId, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.payment_status', actor, fromStatus: from, toStatus: paymentStatus, requestId }, transaction);
  }
};

const notifyMerchant = async (attemptId: number, kind: 'confirmed' | 'review') => {
  try {
    const attempt = await PaymentAttempt.findByPk(attemptId);
    if (!attempt) return;
    const [business, order] = await Promise.all([Business.findByPk(attempt.businessId), Order.findByPk(attempt.orderId, { include: [{ model: Customer, as: 'customer' }] })]);
    if (!business || !order) return;
    if (kind === 'confirmed' && !business.notifyPaymentEmails) return;
    if (kind === 'review' && !business.notifyReviewEmails) return;
    const members = await BusinessMember.findAll({ where: { businessId: business.id } });
    const users = await Auth.findAll({ where: { id: { [Op.in]: members.map((m) => m.userId) } } });
    const link = `${config.app.frontendUrl}/dashboard/orders/${order.publicId}`;
    for (const user of users) {
      await sendMail(
        kind === 'confirmed'
          ? {
              to: user.email,
              subject: `Order ${order.reference} is paid`,
              template: 'payment-confirmed',
              context: { orderReference: order.reference, amount: formatNaira(toMinor(attempt.receivedAmountMinor ?? attempt.expectedAmountMinor)), routeLabel: routeLabel(attempt).toLowerCase(), customerName: order.customer?.name, link },
            }
          : {
              to: user.email,
              subject: `Hold order ${order.reference} for review`,
              template: 'payment-review',
              context: { orderReference: order.reference, reason: (REVIEW_REASON_TEXT[attempt.reviewReason || ''] || 'the payment needs a decision.').toLowerCase(), link },
            },
      );
    }
  } catch (error) {
    logger.error('Merchant notification failed', describeError(error));
  }
};

const ATTEMPT_ACTION: Record<string, string> = {
  awaiting_payment: 'payment.awaiting',
  processing: 'payment.processing',
  confirmed: 'payment.confirmed',
  needs_review: 'payment.needs_review',
  failed: 'payment.failed',
  expired: 'payment.expired',
  cancelled: 'payment.cancelled',
};

// The only code path that changes payment state from provider data. Runs in one transaction with the
// attempt and order rows locked, so concurrent webhooks, polls and refreshes cannot double-apply.
export const applyProviderState = async (attemptId: number, state: ProviderPaymentState, context: ReconcileContext) => {
  const actor: Actor = { type: context.source === 'simulation' ? 'system' : 'provider' };
  // Assigned inside the transaction callback; the cast stops TypeScript narrowing it to null
  let notify = null as 'confirmed' | 'review' | null;

  const attempt = await sequelize.transaction(async (transaction) => {
    const locked = await PaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked) throw new Error('Payment attempt not found');
    if (locked.providerReference !== state.providerReference) throw new Error('Provider reference does not match the attempt');
    const order = await Order.findByPk(locked.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new Error('Order not found for payment attempt');

    locked.providerStatus = state.providerStatus.slice(0, 40);
    locked.lastCheckedAt = new Date();
    locked.checkCount = locked.checkCount + 1;
    if (state.fees.length) locked.providerFees = state.fees;
    if (state.settlement) {
      locked.settlementAmount = state.settlement.amount;
      locked.settlementCurrency = state.settlement.currency;
    }
    if (context.depositEvidence && locked.route === 'bank_transfer' && context.depositEvidence.currency === 'NGN') {
      locked.receivedAmount = context.depositEvidence.amount;
      locked.receivedCurrency = 'NGN';
    } else if (FUNDS_SEEN.includes(state.status) && state.paid && !(locked.route === 'bank_transfer' && locked.receivedAmount && locked.receivedCurrency === 'NGN' && locked.receivedAmountMinor !== null)) {
      locked.receivedAmount = state.paid.amount;
      locked.receivedCurrency = state.paid.currency;
    }
    if (locked.receivedAmount) {
      const ngn = ngnEquivalentMinor(locked, state);
      locked.receivedAmountMinor = ngn === null ? null : ngn.toString();
    }

    const otherConfirmed = await PaymentAttempt.count({ where: { orderId: order.id, status: 'confirmed', id: { [Op.ne]: locked.id } }, transaction });
    const decision = decideTransition(locked, state, otherConfirmed > 0);
    const from = locked.status;
    const metadata = { source: context.source, providerStatus: state.providerStatus, ...(context.eventId ? { eventId: context.eventId } : {}) };

    if (decision?.flag && !locked.reviewReason) {
      locked.reviewReason = decision.flag;
      await recordAudit({ businessId: locked.businessId, orderId: order.id, entityType: 'payment_attempt', entityId: locked.id, action: 'payment.flagged', actor, fromStatus: from, toStatus: from, metadata: { ...metadata, reason: decision.flag }, requestId: context.requestId }, transaction);
      notify = 'review';
    }
    if (decision && decision.next !== from) {
      locked.status = decision.next;
      if (decision.reviewReason) locked.reviewReason = decision.reviewReason;
      if (decision.next === 'failed') locked.failedAt = new Date();
      if (decision.next === 'confirmed') {
        locked.confirmedAt = new Date();
        if (locked.receivedAmountMinor === null) locked.receivedAmountMinor = locked.expectedAmountMinor;
      }
      await recordAudit(
        {
          businessId: locked.businessId,
          orderId: order.id,
          entityType: 'payment_attempt',
          entityId: locked.id,
          action: ATTEMPT_ACTION[decision.next] || 'payment.status',
          actor,
          fromStatus: from,
          toStatus: decision.next,
          metadata: decision.reviewReason ? { ...metadata, reason: decision.reviewReason } : metadata,
          requestId: context.requestId,
        },
        transaction,
      );
      if (decision.next === 'confirmed') notify = 'confirmed';
      if (decision.next === 'needs_review') notify = 'review';
    }
    await locked.save({ transaction });

    if (decision?.next === 'confirmed' && from !== 'confirmed') {
      await createSettlement(locked, transaction, actor, context.requestId);
      const [completed] = await PaymentLink.update({ status: 'completed', completedAt: new Date() }, { where: { id: locked.paymentLinkId, status: { [Op.in]: ['active', 'expired'] } }, transaction });
      if (completed) {
        await recordAudit({ businessId: locked.businessId, orderId: order.id, entityType: 'payment_link', entityId: locked.paymentLinkId, action: 'link.completed', actor, toStatus: 'completed', requestId: context.requestId }, transaction);
      }
    }
    if (decision) await recomputeOrderPayment(order, transaction, actor, context.requestId);
    return locked;
  });

  if (notify) void notifyMerchant(attempt.id, notify);
  return attempt;
};

// Authenticated server-to-server lookup, then reconcile. Throws ProviderError when the provider is unavailable.
export const fetchAndReconcile = async (attemptId: number, context: ReconcileContext) => {
  const attempt = await PaymentAttempt.findByPk(attemptId);
  if (!attempt || !attempt.providerReference) return attempt;
  const provider = getProviderByName(attempt.provider);
  if (!provider) {
    // e.g. a demo record in an environment where the demo provider is unavailable: never reinterpret it
    await attempt.update({ lastCheckedAt: new Date() });
    return attempt;
  }
  const state = await provider.getPaymentState(attempt.route, attempt.providerReference);
  return applyProviderState(attempt.id, state, context);
};

export { createSettlement };

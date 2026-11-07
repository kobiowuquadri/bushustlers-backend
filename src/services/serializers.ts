import { config } from '../config/config.js';
import { REVIEW_REASON_TEXT } from '../constants/payments.js';
import type { Customer, Order, OrderItem, PaymentAttempt, PaymentLink, Settlement } from '../schemas/index.js';

// API DTOs. Money is always a string of integer minor units (kobo) — or an exact decimal string for
// stablecoin amounts — so clients never parse money into floating point.

export const checkoutUrl = (linkPublicId: string) => `${config.app.frontendUrl}/pay/${linkPublicId}`;

export const ATTEMPT_STATUS_TEXT: Record<string, string> = {
  creating: 'Setting up payment instructions with the provider.',
  awaiting_payment: 'Payment instructions were issued to the buyer. Nothing has been received yet.',
  processing: "The provider has detected this payment and is still processing it. Don't ship yet.",
  confirmed: 'Verified with the provider: status, amount, currency and reference all match. Safe to fulfil.',
  needs_review: 'Money or a provider status needs your decision before this order ships.',
  failed: 'The provider reported that this payment failed. No money was confirmed.',
  expired: 'The payment instructions expired before any money arrived. Late funds are still watched for 48 hours.',
  cancelled: 'These payment instructions were closed. Late funds are still watched for 48 hours.',
};

export const effectiveLinkStatus = (link: PaymentLink) =>
  link.status === 'active' && link.expiresAt.getTime() < Date.now() ? 'expired' : link.status;

export const serializeCustomer = (customer: Customer) => ({
  id: customer.publicId,
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  handle: customer.handle,
  createdAt: customer.createdAt,
});

export const serializeItem = (item: OrderItem) => ({
  name: item.name,
  quantity: item.quantity,
  unitPriceMinor: String(item.unitPriceMinor),
  lineTotalMinor: String(item.lineTotalMinor),
});

export const serializeLink = (link: PaymentLink) => ({
  id: link.publicId,
  url: checkoutUrl(link.publicId),
  status: effectiveLinkStatus(link),
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
  disabledAt: link.disabledAt,
  completedAt: link.completedAt,
});

export const itemSummary = (items: OrderItem[] = []) => {
  if (!items.length) return 'No items yet';
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return sorted.length > 1 ? `${sorted[0].name} + ${sorted.length - 1} more` : sorted[0].name;
};

export const serializeOrderSummary = (order: Order, link?: PaymentLink | null) => ({
  id: order.publicId,
  reference: order.reference,
  status: order.status,
  paymentStatus: order.paymentStatus,
  fulfilmentStatus: order.fulfilmentStatus,
  reviewRequired: order.reviewRequired,
  currency: order.currency,
  totalMinor: String(order.totalMinor),
  amountPaidMinor: String(order.amountPaidMinor),
  itemSummary: itemSummary(order.items),
  itemCount: order.items?.length ?? 0,
  customer: order.customer ? { id: order.customer.publicId, name: order.customer.name } : null,
  link: link ? serializeLink(link) : null,
  createdAt: order.createdAt,
  paidAt: order.paidAt,
  dispatchedAt: order.dispatchedAt,
  deliveredAt: order.deliveredAt,
});

export const routeLabel = (attempt: Pick<PaymentAttempt, 'route' | 'asset' | 'network'>) =>
  attempt.route === 'bank_transfer' ? 'Bank transfer (NGN)' : `${attempt.asset} on ${attempt.network}`;

export const serializeAttempt = (
  attempt: PaymentAttempt,
  extras: { order?: Pick<Order, 'publicId' | 'reference'> | null; settlement?: Settlement | null } = {},
) => ({
  id: attempt.publicId,
  reference: attempt.reference,
  route: attempt.route,
  routeLabel: routeLabel(attempt),
  status: attempt.status,
  statusText: ATTEMPT_STATUS_TEXT[attempt.status],
  reviewReason: attempt.reviewReason,
  reviewReasonText: attempt.reviewReason ? REVIEW_REASON_TEXT[attempt.reviewReason] ?? null : null,
  resolution: attempt.reviewResolution ? { decision: attempt.reviewResolution, note: attempt.resolutionNote, resolvedAt: attempt.resolvedAt } : null,
  provider: attempt.provider,
  providerMode: attempt.providerMode,
  providerReference: attempt.providerReference,
  providerStatus: attempt.providerStatus,
  currency: attempt.currency,
  expectedAmountMinor: String(attempt.expectedAmountMinor),
  receivedAmountMinor: attempt.receivedAmountMinor === null ? null : String(attempt.receivedAmountMinor),
  asset: attempt.asset,
  network: attempt.network,
  assetAmount: attempt.assetAmount,
  receivedAmount: attempt.receivedAmount,
  receivedCurrency: attempt.receivedCurrency,
  settlementAmount: attempt.settlementAmount,
  settlementCurrency: attempt.settlementCurrency,
  rate: attempt.rate,
  rateSource: attempt.rateSource,
  providerFees: attempt.providerFees ?? [],
  platformFeeMinor: extras.settlement ? String(extras.settlement.platformFeeMinor) : null,
  order: extras.order ? { id: extras.order.publicId, reference: extras.order.reference } : null,
  createdAt: attempt.createdAt,
  expiresAt: attempt.expiresAt,
  confirmedAt: attempt.confirmedAt,
  failedAt: attempt.failedAt,
  lastCheckedAt: attempt.lastCheckedAt,
});

export const serializeSettlement = (settlement: Settlement, extras: { order?: Pick<Order, 'publicId' | 'reference'> | null; attempt?: PaymentAttempt | null } = {}) => ({
  id: settlement.publicId,
  status: settlement.status,
  currency: settlement.currency,
  grossMinor: String(settlement.grossMinor),
  providerFeeMinor: String(settlement.providerFeeMinor),
  platformFeeMinor: String(settlement.platformFeeMinor),
  netMinor: String(settlement.netMinor),
  feeBasis: settlement.feeBasis,
  payoutReference: settlement.payoutReference,
  settledAt: settlement.settledAt,
  failureReason: settlement.failureReason,
  simulated: settlement.simulated,
  createdAt: settlement.createdAt,
  order: extras.order ? { id: extras.order.publicId, reference: extras.order.reference } : null,
  payment: extras.attempt ? { id: extras.attempt.publicId, route: extras.attempt.route, routeLabel: routeLabel(extras.attempt) } : null,
});

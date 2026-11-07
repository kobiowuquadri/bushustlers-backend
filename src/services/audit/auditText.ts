import { REVIEW_REASON_TEXT } from '../../constants/payments.js';
import type { AuditEvent } from '../../schemas/index.js';

const STATUS_WORDS: Record<string, string> = {
  awaiting_payment: 'awaiting payment',
  processing: 'processing',
  confirmed: 'confirmed',
  needs_review: 'needs review',
  failed: 'failed',
  expired: 'expired',
  cancelled: 'cancelled',
  creating: 'being set up',
};

const ROUTE_TEXT = (metadata: Record<string, unknown> | null) => {
  if (!metadata) return 'a payment';
  if (metadata.route === 'bank_transfer') return 'a bank transfer';
  if (metadata.route === 'stablecoin') return `a ${String(metadata.asset ?? 'stablecoin')} payment on ${String(metadata.network ?? '')}`.trim();
  return 'a payment';
};

// Human-readable timeline entry. Metadata is passed through only for known-safe keys.
export const describeAuditEvent = (event: AuditEvent) => {
  const m = event.metadata;
  let label: string;
  switch (event.action) {
    case 'order.created': label = 'Order created'; break;
    case 'order.updated': label = 'Order details edited'; break;
    case 'order.cancelled': label = 'Order cancelled'; break;
    case 'order.expired': label = 'Payment link expired without payment'; break;
    case 'order.dispatched': label = 'Marked as dispatched'; break;
    case 'order.delivered': label = 'Marked as delivered'; break;
    case 'order.payment_status': label = `Payment status changed to ${STATUS_WORDS[event.toStatus || ''] ?? event.toStatus}`; break;
    case 'link.created': label = 'Payment link created'; break;
    case 'link.disabled': label = 'Payment link disabled'; break;
    case 'link.expired': label = 'Payment link expired'; break;
    case 'link.completed': label = 'Payment link completed'; break;
    case 'payment.started': label = `Buyer started ${ROUTE_TEXT(m)}`; break;
    case 'payment.setup_failed': label = 'Payment setup failed at the provider'; break;
    case 'payment.awaiting': label = 'Payment instructions issued to the buyer'; break;
    case 'payment.processing': label = 'Payment detected, provider is processing'; break;
    case 'payment.confirmed': label = 'Payment confirmed with the provider'; break;
    case 'payment.needs_review': label = `Payment held for review: ${REVIEW_REASON_TEXT[String(m?.reason)] ?? 'needs a decision'}`; break;
    case 'payment.flagged': label = `Confirmed payment flagged: ${REVIEW_REASON_TEXT[String(m?.reason)] ?? 'needs a decision'}`; break;
    case 'payment.failed': label = 'Provider reported the payment failed'; break;
    case 'payment.expired': label = 'Payment instructions expired'; break;
    case 'payment.cancelled': label = 'Payment instructions closed'; break;
    case 'payment.resolved': label = 'Review resolved: payment accepted by the business'; break;
    case 'payment.review_note': label = 'Review note added; payment kept on hold'; break;
    case 'settlement.created': label = 'Settlement pending'; break;
    case 'settlement.settled': label = 'Settled'; break;
    case 'settlement.failed': label = 'Settlement failed'; break;
    default: label = event.action;
  }
  const safeMetadata: Record<string, unknown> = {};
  for (const key of ['reason', 'route', 'asset', 'network', 'note', 'source', 'simulated']) {
    if (m && m[key] !== undefined) safeMetadata[key] = m[key];
  }
  return {
    action: event.action,
    label,
    actor: event.actorType,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    metadata: safeMetadata,
    createdAt: event.createdAt,
  };
};

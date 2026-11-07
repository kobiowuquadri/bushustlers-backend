import sequelize from '../../database/db.js';
import { Order, PaymentAttempt, PaymentLink } from '../../schemas/index.js';
import { recordAudit } from '../audit/auditService.js';
import { recomputeOrderPayment } from './reconciliationService.js';

// Marks an active link as expired once its time has passed. An unpaid open order becomes "expired"
// (the merchant can create a new link). Paid or in-progress orders are left untouched.
export const expirePaymentLink = async (linkId: number) =>
  sequelize.transaction(async (transaction) => {
    const link = await PaymentLink.findByPk(linkId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!link || link.status !== 'active' || link.expiresAt.getTime() > Date.now()) return false;
    const order = await Order.findByPk(link.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    await link.update({ status: 'expired' }, { transaction });
    await recordAudit({ businessId: link.businessId, orderId: link.orderId, entityType: 'payment_link', entityId: link.id, action: 'link.expired', actor: { type: 'system' }, fromStatus: 'active', toStatus: 'expired' }, transaction);
    if (order && order.status === 'open' && order.paymentStatus === 'unpaid') {
      await order.update({ status: 'expired' }, { transaction });
      await recordAudit({ businessId: order.businessId, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.expired', actor: { type: 'system' }, fromStatus: 'open', toStatus: 'expired' }, transaction);
    }
    return true;
  });

// Instructions whose validity has passed are closed locally even if the provider has not said so yet.
// The reconciler keeps checking closed attempts for late funds, which become an explicit review case.
export const expireAttemptLocally = async (attemptId: number) =>
  sequelize.transaction(async (transaction) => {
    const attempt = await PaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!attempt || attempt.status !== 'awaiting_payment' || !attempt.expiresAt || attempt.expiresAt.getTime() > Date.now()) return false;
    const order = await Order.findByPk(attempt.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    await attempt.update({ status: 'expired' }, { transaction });
    await recordAudit({ businessId: attempt.businessId, orderId: attempt.orderId, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.expired', actor: { type: 'system' }, fromStatus: 'awaiting_payment', toStatus: 'expired' }, transaction);
    if (order) await recomputeOrderPayment(order, transaction, { type: 'system' });
    return true;
  });

import { Op, type WhereOptions } from 'sequelize';
import sequelize from '../../database/db.js';
import { config } from '../../config/config.js';
import { Customer, Order, OrderItem, PaymentAttempt, PaymentLink, type Business } from '../../schemas/index.js';
import { appError, getPagination, linkPublicId, messageHandler, paginate, toMinor } from '../../utils/index.js';
import { CONFLICT, CREATED, NOT_FOUND, SUCCESS } from '../../constants/statusCode.js';
import { recordAudit } from '../audit/auditService.js';
import { effectiveLinkStatus, serializeAttempt, serializeLink, serializeOrderSummary } from '../serializers.js';
import { findOwnedOrder, loadOrderDetail } from './orderService.js';

export const LINK_TTL_OPTIONS_HOURS = [24, 72, 168] as const;

export const createPaymentLinkService = async (business: Business, orderPublicId: string, input: { expiresInHours?: number }, userId: number, requestId?: string) => {
  const ttlHours = input.expiresInHours ?? config.payments.linkTtlHoursDefault;

  await sequelize.transaction(async (transaction) => {
    const order = await findOwnedOrder(business.id, orderPublicId, { transaction, lock: true });
    const links = await PaymentLink.findAll({ where: { orderId: order.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    const actor = { type: 'user' as const, id: userId };

    // Retire links that have quietly passed their expiry
    for (const link of links.filter((l) => effectiveLinkStatus(l) === 'expired')) {
      await link.update({ status: 'expired' }, { transaction });
      await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_link', entityId: link.id, action: 'link.expired', actor: { type: 'system' }, fromStatus: 'active', toStatus: 'expired', requestId }, transaction);
    }
    if (links.some((l) => effectiveLinkStatus(l) === 'active')) {
      throw appError(CONFLICT, 'link_exists', 'This order already has an active payment link');
    }
    if (order.status === 'cancelled') throw appError(CONFLICT, 'order_cancelled', 'This order is cancelled');
    if (order.paymentStatus !== 'unpaid') throw appError(CONFLICT, 'order_has_payment', 'This order already has a payment in progress or confirmed');
    if (toMinor(order.totalMinor) <= 0n || !(await OrderItem.count({ where: { orderId: order.id }, transaction }))) {
      throw appError(CONFLICT, 'order_incomplete', 'Add at least one item before creating a payment link');
    }

    const link = await PaymentLink.create(
      { publicId: linkPublicId(), businessId: business.id, orderId: order.id, expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000) },
      { transaction },
    );
    const from = order.status;
    await order.update({ status: 'open' }, { transaction });
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_link', entityId: link.id, action: 'link.created', actor, toStatus: 'active', metadata: { expiresInHours: ttlHours }, requestId }, transaction);
    if (from !== 'open') {
      await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.payment_status', actor, fromStatus: 'unpaid', toStatus: 'awaiting_payment', requestId }, transaction);
    }
  });

  const order = await loadOrderDetail(business, orderPublicId);
  return messageHandler('Payment link created', true, CREATED, { link: order.link, order });
};

const findOwnedLink = async (businessId: number, linkId: string) => {
  const link = await PaymentLink.findOne({ where: { publicId: linkId, businessId } });
  if (!link) throw appError(NOT_FOUND, 'link_not_found', 'Payment link not found');
  return link;
};

export const listPaymentLinksService = async (business: Business, query: { status?: string; page?: unknown; limit?: unknown }) => {
  const { page, limit, offset } = getPagination(query, 20, 100);
  const now = new Date();
  const where: WhereOptions = { businessId: business.id };
  if (query.status === 'active') Object.assign(where, { status: 'active', expiresAt: { [Op.gt]: now } });
  else if (query.status === 'expired') Object.assign(where, { [Op.or]: [{ status: 'expired' }, { status: 'active', expiresAt: { [Op.lte]: now } }] });
  else if (query.status === 'disabled' || query.status === 'completed') Object.assign(where, { status: query.status });

  const result = await PaymentLink.findAndCountAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit, offset });
  const orderIds = [...new Set(result.rows.map((l) => l.orderId))];
  const orders = orderIds.length
    ? await Order.findAll({ where: { id: { [Op.in]: orderIds } }, include: [{ model: Customer, as: 'customer' }, { model: OrderItem, as: 'items' }] })
    : [];
  const attempts = orderIds.length
    ? await PaymentAttempt.findAll({ where: { paymentLinkId: { [Op.in]: result.rows.map((l) => l.id) }, status: { [Op.ne]: 'creating' } }, order: [['createdAt', 'DESC']] })
    : [];
  const { pagination } = paginate(result, page, limit);
  return messageHandler('Payment links retrieved', true, SUCCESS, {
    items: result.rows.map((link) => {
      const order = orders.find((o) => o.id === link.orderId);
      const latest = attempts.find((a) => a.paymentLinkId === link.id);
      return {
        ...serializeLink(link),
        order: order ? serializeOrderSummary(order) : null,
        latestPayment: latest ? serializeAttempt(latest) : null,
        paymentCount: attempts.filter((a) => a.paymentLinkId === link.id).length,
      };
    }),
    pagination,
  });
};

export const disablePaymentLinkService = async (business: Business, linkId: string, userId: number, requestId?: string) => {
  const owned = await findOwnedLink(business.id, linkId);
  await sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(owned.orderId, { transaction, lock: transaction.LOCK.UPDATE });
    const link = await PaymentLink.findByPk(owned.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order || !link) throw appError(NOT_FOUND, 'link_not_found', 'Payment link not found');
    if (link.status !== 'active') throw appError(CONFLICT, 'link_not_active', `This link is already ${link.status}`);
    if (order.paymentStatus !== 'unpaid') {
      throw appError(CONFLICT, 'order_has_payment', 'This link has a payment in progress, under review or confirmed, so it cannot be disabled');
    }
    const actor = { type: 'user' as const, id: userId };
    await link.update({ status: 'disabled', disabledAt: new Date() }, { transaction });
    // Instructions already shown to a buyer are closed locally; late funds are still watched and flagged
    const open = await PaymentAttempt.findAll({ where: { paymentLinkId: link.id, status: { [Op.in]: ['creating', 'awaiting_payment'] } }, transaction, lock: transaction.LOCK.UPDATE });
    for (const attempt of open) {
      await attempt.update({ status: 'cancelled' }, { transaction });
      await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_attempt', entityId: attempt.id, action: 'payment.cancelled', actor, fromStatus: 'awaiting_payment', toStatus: 'cancelled', requestId }, transaction);
    }
    if (order.status === 'open') await order.update({ status: 'draft' }, { transaction });
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_link', entityId: link.id, action: 'link.disabled', actor, fromStatus: 'active', toStatus: 'disabled', requestId }, transaction);
  });
  const fresh = await PaymentLink.findByPk(owned.id);
  return messageHandler('Payment link disabled', true, SUCCESS, { link: serializeLink(fresh!) });
};

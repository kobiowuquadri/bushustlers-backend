import { Op, type Transaction, type WhereOptions } from 'sequelize';
import sequelize from '../../database/db.js';
import { AuditEvent, Business, Customer, Order, OrderItem, PaymentAttempt, PaymentLink, Settlement } from '../../schemas/index.js';
import type { FulfilmentStatus } from '../../schemas/commerce/orderSchema.js';
import { appError, getPagination, messageHandler, paginate, publicId, toMinor, MAX_ORDER_MINOR } from '../../utils/index.js';
import { CONFLICT, CREATED, NOT_FOUND, SUCCESS, VALIDATION_ERROR } from '../../constants/statusCode.js';
import { recordAudit } from '../audit/auditService.js';
import { escapeLike, resolveCustomerForOrder, type CustomerInput } from './customerService.js';
import { effectiveLinkStatus, serializeAttempt, serializeCustomer, serializeItem, serializeLink, serializeOrderSummary, serializeSettlement } from '../serializers.js';
import { describeAuditEvent } from '../audit/auditText.js';

export interface OrderItemInput {
  name: string;
  quantity: number;
  unitPriceMinor: string;
}

export interface OrderInput {
  customer?: CustomerInput;
  items: OrderItemInput[];
  deliveryFeeMinor?: string;
  note?: string | null;
}

export const ORDER_VIEWS = ['all', 'awaiting_payment', 'to_fulfil', 'needs_review', 'fulfilled', 'draft', 'closed'] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];

const FUNDS_STATUSES = ['processing', 'confirmed', 'needs_review'] as const;

// Totals are always calculated here, in BigInt minor units; client-supplied totals are never trusted.
export const calculateTotals = (items: OrderItemInput[], deliveryFeeMinor?: string) => {
  const lines = items.map((item, position) => {
    const unit = toMinor(item.unitPriceMinor);
    return { name: item.name.trim(), quantity: item.quantity, unitPriceMinor: unit, lineTotalMinor: unit * BigInt(item.quantity), position };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
  const delivery = toMinor(deliveryFeeMinor ?? '0');
  const total = subtotal + delivery;
  if (total <= 0n) throw appError(VALIDATION_ERROR, 'invalid_total', 'The order total must be more than ₦0');
  if (total > MAX_ORDER_MINOR) throw appError(VALIDATION_ERROR, 'invalid_total', 'The order total is above the ₦100,000,000 limit');
  return { lines, subtotal, delivery, total };
};

export const findOwnedOrder = async (businessId: number, orderPublicId: string, options: { transaction?: Transaction; lock?: boolean } = {}) => {
  const order = await Order.findOne({
    where: { publicId: orderPublicId, businessId },
    transaction: options.transaction,
    lock: options.lock && options.transaction ? options.transaction.LOCK.UPDATE : undefined,
  });
  if (!order) throw appError(NOT_FOUND, 'order_not_found', 'Order not found');
  return order;
};

const activeLinkFor = (links: PaymentLink[]) => links.find((link) => effectiveLinkStatus(link) === 'active') ?? null;

const orderFlags = (order: Order, links: PaymentLink[], attempts: PaymentAttempt[], itemCount: number) => {
  const hasActiveLink = Boolean(activeLinkFor(links));
  const hasFunds = attempts.some((a) => (FUNDS_STATUSES as readonly string[]).includes(a.status));
  const editable = ['draft', 'expired'].includes(order.status) && order.paymentStatus === 'unpaid' && !hasActiveLink && !hasFunds;
  return {
    editable,
    canCreateLink: editable && itemCount > 0 && toMinor(order.totalMinor) > 0n,
    canCancel: order.status !== 'cancelled' && order.paymentStatus === 'unpaid' && !attempts.some((a) => a.status === 'processing'),
    canFulfil: order.paymentStatus === 'paid' && order.fulfilmentStatus !== 'delivered',
    receiptAvailable: order.paymentStatus === 'paid',
  };
};

export const loadOrderDetail = async (business: Business, orderPublicId: string) => {
  const order = await Order.findOne({
    where: { publicId: orderPublicId, businessId: business.id },
    include: [
      { model: OrderItem, as: 'items' },
      { model: Customer, as: 'customer' },
    ],
    order: [[{ model: OrderItem, as: 'items' }, 'position', 'ASC']],
  });
  if (!order) throw appError(NOT_FOUND, 'order_not_found', 'Order not found');

  const [links, attempts, settlements, events] = await Promise.all([
    PaymentLink.findAll({ where: { orderId: order.id }, order: [['createdAt', 'DESC']] }),
    PaymentAttempt.findAll({ where: { orderId: order.id, status: { [Op.ne]: 'creating' } }, order: [['createdAt', 'DESC']] }),
    Settlement.findAll({ where: { orderId: order.id } }),
    AuditEvent.findAll({ where: { orderId: order.id, businessId: business.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']], limit: 200 }),
  ]);
  const settlementByAttempt = new Map(settlements.map((s) => [s.paymentAttemptId, s]));
  const activeLink = activeLinkFor(links);

  return {
    ...serializeOrderSummary(order, activeLink),
    subtotalMinor: String(order.subtotalMinor),
    deliveryFeeMinor: String(order.deliveryFeeMinor),
    note: order.note,
    fulfilmentNote: order.fulfilmentNote,
    cancelledAt: order.cancelledAt,
    items: (order.items || []).map(serializeItem),
    customer: order.customer ? serializeCustomer(order.customer) : null,
    links: links.map(serializeLink),
    payments: attempts.map((attempt) => serializeAttempt(attempt, { order, settlement: settlementByAttempt.get(attempt.id) })),
    settlements: settlements.map((s) => serializeSettlement(s, { order, attempt: attempts.find((a) => a.id === s.paymentAttemptId) })),
    events: events.map(describeAuditEvent),
    ...orderFlags(order, links, attempts, order.items?.length ?? 0),
  };
};

export const getOrderService = async (business: Business, orderPublicId: string) =>
  messageHandler('Order retrieved', true, SUCCESS, { order: await loadOrderDetail(business, orderPublicId) });

export const createOrderService = async (business: Business, input: OrderInput, userId: number, requestId?: string) => {
  const totals = calculateTotals(input.items, input.deliveryFeeMinor);

  const orderPublicId = await sequelize.transaction(async (transaction) => {
    // Lock the business row so concurrent orders get distinct, sequential references
    const locked = await Business.findByPk(business.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked) throw appError(NOT_FOUND, 'business_not_found', 'Business not found');
    const reference = `${locked.orderPrefix}-${locked.nextOrderNumber}`;
    await locked.update({ nextOrderNumber: locked.nextOrderNumber + 1 }, { transaction });

    const customer = await resolveCustomerForOrder(business, input.customer, transaction);
    const order = await Order.create(
      {
        publicId: publicId('ord'),
        businessId: business.id,
        customerId: customer?.id ?? null,
        reference,
        subtotalMinor: totals.subtotal.toString(),
        deliveryFeeMinor: totals.delivery.toString(),
        totalMinor: totals.total.toString(),
        note: input.note || null,
      },
      { transaction },
    );
    await OrderItem.bulkCreate(
      totals.lines.map((line) => ({ ...line, orderId: order.id, unitPriceMinor: line.unitPriceMinor.toString(), lineTotalMinor: line.lineTotalMinor.toString() })),
      { transaction },
    );
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.created', actor: { type: 'user', id: userId }, toStatus: 'draft', metadata: { reference, totalMinor: totals.total.toString() }, requestId }, transaction);
    return order.publicId;
  });

  return messageHandler('Order created', true, CREATED, { order: await loadOrderDetail(business, orderPublicId) });
};

export const updateOrderService = async (business: Business, orderPublicId: string, input: OrderInput, userId: number, requestId?: string) => {
  const totals = calculateTotals(input.items, input.deliveryFeeMinor);

  await sequelize.transaction(async (transaction) => {
    const order = await findOwnedOrder(business.id, orderPublicId, { transaction, lock: true });
    const links = await PaymentLink.findAll({ where: { orderId: order.id }, transaction });
    const attempts = await PaymentAttempt.findAll({ where: { orderId: order.id }, transaction });
    if (!orderFlags(order, links, attempts, 1).editable) {
      throw appError(CONFLICT, 'order_locked', activeLinkFor(links) ? 'Disable the payment link before editing this order' : 'This order can no longer be edited');
    }
    const customer = input.customer ? await resolveCustomerForOrder(business, input.customer, transaction) : null;
    await OrderItem.destroy({ where: { orderId: order.id }, transaction });
    await OrderItem.bulkCreate(
      totals.lines.map((line) => ({ ...line, orderId: order.id, unitPriceMinor: line.unitPriceMinor.toString(), lineTotalMinor: line.lineTotalMinor.toString() })),
      { transaction },
    );
    await order.update(
      {
        customerId: input.customer ? customer?.id ?? null : order.customerId,
        subtotalMinor: totals.subtotal.toString(),
        deliveryFeeMinor: totals.delivery.toString(),
        totalMinor: totals.total.toString(),
        note: input.note === undefined ? order.note : input.note || null,
      },
      { transaction },
    );
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.updated', actor: { type: 'user', id: userId }, metadata: { totalMinor: totals.total.toString() }, requestId }, transaction);
  });

  return messageHandler('Order updated', true, SUCCESS, { order: await loadOrderDetail(business, orderPublicId) });
};

export const cancelOrderService = async (business: Business, orderPublicId: string, userId: number, requestId?: string) => {
  await sequelize.transaction(async (transaction) => {
    const order = await findOwnedOrder(business.id, orderPublicId, { transaction, lock: true });
    if (order.status === 'cancelled') throw appError(CONFLICT, 'already_cancelled', 'This order is already cancelled');
    if (order.paymentStatus !== 'unpaid') {
      throw appError(CONFLICT, 'order_has_payment', 'Orders with a payment in progress, under review or confirmed cannot be cancelled here');
    }
    const now = new Date();
    const actor = { type: 'user' as const, id: userId };
    const links = await PaymentLink.findAll({ where: { orderId: order.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    for (const link of links) {
      await link.update({ status: 'disabled', disabledAt: now }, { transaction });
      await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'payment_link', entityId: link.id, action: 'link.disabled', actor, fromStatus: 'active', toStatus: 'disabled', metadata: { reason: 'order_cancelled' }, requestId }, transaction);
    }
    // Closed locally; the reconciler still watches these for late funds
    const open = await PaymentAttempt.findAll({ where: { orderId: order.id, status: { [Op.in]: ['creating', 'awaiting_payment'] } }, transaction, lock: transaction.LOCK.UPDATE });
    for (const attempt of open) {
      await attempt.update({ status: 'cancelled' }, { transaction });
    }
    const from = order.status;
    await order.update({ status: 'cancelled', cancelledAt: now }, { transaction });
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'order', entityId: order.id, action: 'order.cancelled', actor, fromStatus: from, toStatus: 'cancelled', requestId }, transaction);
  });
  return messageHandler('Order cancelled', true, SUCCESS, { order: await loadOrderDetail(business, orderPublicId) });
};

const FULFILMENT_ORDER: FulfilmentStatus[] = ['unfulfilled', 'dispatched', 'delivered'];

export const updateFulfilmentService = async (
  business: Business,
  orderPublicId: string,
  input: { status: Exclude<FulfilmentStatus, 'unfulfilled'>; note?: string | null },
  userId: number,
  requestId?: string,
) => {
  await sequelize.transaction(async (transaction) => {
    const order = await findOwnedOrder(business.id, orderPublicId, { transaction, lock: true });
    // "Paid means ship": fulfilment is only recorded once the payment is confirmed by the provider
    if (order.paymentStatus !== 'paid') {
      throw appError(CONFLICT, 'not_paid', order.paymentStatus === 'needs_review' ? 'Resolve the payment review before fulfilling this order' : "Don't ship yet: this order is not paid");
    }
    if (FULFILMENT_ORDER.indexOf(input.status) <= FULFILMENT_ORDER.indexOf(order.fulfilmentStatus)) {
      throw appError(CONFLICT, 'invalid_fulfilment', `This order is already ${order.fulfilmentStatus}`);
    }
    const now = new Date();
    const from = order.fulfilmentStatus;
    await order.update(
      {
        fulfilmentStatus: input.status,
        dispatchedAt: order.dispatchedAt ?? now,
        deliveredAt: input.status === 'delivered' ? now : order.deliveredAt,
        fulfilmentNote: input.note === undefined ? order.fulfilmentNote : input.note || null,
      },
      { transaction },
    );
    await recordAudit({ businessId: business.id, orderId: order.id, entityType: 'order', entityId: order.id, action: `order.${input.status}`, actor: { type: 'user', id: userId }, fromStatus: from, toStatus: input.status, metadata: input.note ? { note: input.note } : null, requestId }, transaction);
  });
  return messageHandler(input.status === 'dispatched' ? 'Marked as dispatched' : 'Marked as delivered', true, SUCCESS, { order: await loadOrderDetail(business, orderPublicId) });
};

const viewWhere = (view: OrderView): WhereOptions => {
  switch (view) {
    case 'awaiting_payment':
      return { status: 'open', paymentStatus: { [Op.in]: ['unpaid', 'processing'] } };
    case 'to_fulfil':
      return { paymentStatus: 'paid', fulfilmentStatus: 'unfulfilled' };
    case 'needs_review':
      return { [Op.or]: [{ paymentStatus: 'needs_review' }, { reviewRequired: true }] };
    case 'fulfilled':
      return { fulfilmentStatus: { [Op.in]: ['dispatched', 'delivered'] } };
    case 'draft':
      return { status: 'draft' };
    case 'closed':
      return { status: { [Op.in]: ['expired', 'cancelled'] } };
    default:
      return {};
  }
};

export const listOrdersService = async (business: Business, query: { view?: OrderView; search?: string; customer?: string; page?: unknown; limit?: unknown }) => {
  const { page, limit, offset } = getPagination(query, 20, 100);
  const conditions: WhereOptions[] = [{ businessId: business.id }, viewWhere(query.view || 'all')];
  const search = query.search?.trim();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    conditions.push({ [Op.or]: [{ reference: { [Op.like]: like } }, { '$customer.name$': { [Op.like]: like } }, { '$customer.email$': { [Op.like]: like } }, { '$customer.phone$': { [Op.like]: like } }] });
  }
  if (query.customer) {
    const customer = await Customer.findOne({ where: { publicId: query.customer, businessId: business.id } });
    conditions.push({ customerId: customer?.id ?? -1 });
  }

  const result = await Order.findAndCountAll({
    where: { [Op.and]: conditions },
    include: [{ model: Customer, as: 'customer', required: false }],
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  });
  const ids = result.rows.map((o) => o.id);
  const [items, links] = ids.length
    ? await Promise.all([
        OrderItem.findAll({ where: { orderId: { [Op.in]: ids } }, order: [['position', 'ASC']] }),
        PaymentLink.findAll({ where: { orderId: { [Op.in]: ids }, status: 'active' } }),
      ])
    : [[], []];
  const { pagination } = paginate(result, page, limit);
  return messageHandler('Orders retrieved', true, SUCCESS, {
    items: result.rows.map((order) => {
      order.items = items.filter((item) => item.orderId === order.id);
      return serializeOrderSummary(order, activeLinkFor(links.filter((link) => link.orderId === order.id)));
    }),
    pagination,
  });
};

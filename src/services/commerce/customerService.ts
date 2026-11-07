import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import sequelize from '../../database/db.js';
import { Customer, Order, type Business } from '../../schemas/index.js';
import { appError, getPagination, messageHandler, paginate, publicId } from '../../utils/index.js';
import { NOT_FOUND, SUCCESS } from '../../constants/statusCode.js';
import { serializeCustomer, serializeOrderSummary } from '../serializers.js';
import { recordAudit } from '../audit/auditService.js';
import { OrderItem } from '../../schemas/commerce/orderSchema.js';

export interface CustomerInput {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  handle?: string | null;
}

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const findOwnedCustomer = async (businessId: number, customerPublicId: string, transaction?: Transaction) => {
  // Scoped by businessId: another merchant's customer id simply does not exist for this business
  const customer = await Customer.findOne({ where: { publicId: customerPublicId, businessId }, transaction });
  if (!customer) throw appError(NOT_FOUND, 'customer_not_found', 'Customer not found');
  return customer;
};

// Reuse an existing customer (explicit id, or same email/phone within this business) or create one.
export const resolveCustomerForOrder = async (business: Business, input: CustomerInput | undefined, transaction: Transaction) => {
  if (!input) return null;
  if (input.id) return findOwnedCustomer(business.id, input.id, transaction);
  if (!input.name) return null;

  const matches: WhereOptions[] = [];
  if (input.email) matches.push({ email: input.email });
  if (input.phone) matches.push({ phone: input.phone });
  if (matches.length) {
    const existing = await Customer.findOne({ where: { businessId: business.id, [Op.or]: matches }, transaction });
    if (existing) {
      // Fill in contact details the merchant did not have before, without overwriting existing ones
      await existing.update(
        {
          email: existing.email ?? input.email ?? null,
          phone: existing.phone ?? input.phone ?? null,
          handle: existing.handle ?? input.handle ?? null,
        },
        { transaction },
      );
      return existing;
    }
  }
  return Customer.create(
    { publicId: publicId('cus'), businessId: business.id, name: input.name, email: input.email || null, phone: input.phone || null, handle: input.handle || null },
    { transaction },
  );
};

interface CustomerStats {
  customerId: number;
  orderCount: string;
  paidMinor: string | null;
  lastOrderAt: Date | null;
}

const statsFor = async (businessId: number, customerIds: number[]) => {
  if (!customerIds.length) return new Map<number, CustomerStats>();
  const rows = await sequelize.query<CustomerStats>(
    `SELECT customerId, COUNT(*) AS orderCount, SUM(amountPaidMinor) AS paidMinor, MAX(createdAt) AS lastOrderAt
       FROM orders WHERE businessId = :businessId AND customerId IN (:customerIds) GROUP BY customerId`,
    { replacements: { businessId, customerIds }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((row) => [Number(row.customerId), row]));
};

const withStats = (customer: Customer, stats?: CustomerStats) => ({
  ...serializeCustomer(customer),
  orderCount: Number(stats?.orderCount ?? 0),
  totalPaidMinor: String(stats?.paidMinor ?? '0'),
  lastOrderAt: stats?.lastOrderAt ?? null,
});

export const listCustomersService = async (business: Business, query: { search?: string; page?: unknown; limit?: unknown }) => {
  const { page, limit, offset } = getPagination(query, 20, 100);
  const where: WhereOptions = { businessId: business.id };
  const search = query.search?.trim();
  if (search) {
    const like = `%${escapeLike(search)}%`;
    Object.assign(where, { [Op.or]: [{ name: { [Op.like]: like } }, { email: { [Op.like]: like } }, { phone: { [Op.like]: like } }, { handle: { [Op.like]: like } }] });
  }
  const result = await Customer.findAndCountAll({ where, order: [['updatedAt', 'DESC'], ['id', 'DESC']], limit, offset });
  const stats = await statsFor(business.id, result.rows.map((c) => c.id));
  const { items, pagination } = paginate(result, page, limit);
  return messageHandler('Customers retrieved', true, SUCCESS, { items: items.map((c) => withStats(c, stats.get(c.id))), pagination });
};

export const getCustomerService = async (business: Business, customerPublicId: string) => {
  const customer = await findOwnedCustomer(business.id, customerPublicId);
  const orders = await Order.findAll({
    where: { businessId: business.id, customerId: customer.id },
    include: [{ model: OrderItem, as: 'items' }],
    order: [['createdAt', 'DESC']],
    limit: 50,
  });
  const stats = await statsFor(business.id, [customer.id]);
  return messageHandler('Customer retrieved', true, SUCCESS, {
    customer: withStats(customer, stats.get(customer.id)),
    orders: orders.map((order) => serializeOrderSummary(order)),
  });
};

export const updateCustomerService = async (business: Business, customerPublicId: string, input: CustomerInput, userId: number, requestId?: string) => {
  const customer = await findOwnedCustomer(business.id, customerPublicId);
  const patch: Partial<Customer> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.email !== undefined) patch.email = input.email || null;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  if (input.handle !== undefined) patch.handle = input.handle || null;
  await customer.update(patch);
  await recordAudit({ businessId: business.id, entityType: 'customer', entityId: customer.id, action: 'customer.updated', actor: { type: 'user', id: userId }, metadata: { fields: Object.keys(patch) }, requestId });
  return messageHandler('Customer updated', true, SUCCESS, { customer: serializeCustomer(customer) });
};

// Loads every model and wires associations once. Import models from here in services.
// Foreign keys are created by migrations, so associations use constraints: false.
import Auth from './users/authSchema.js';
import AuthSession from './users/sessionSchema.js';
import AuthToken from './users/authTokenSchema.js';
import { Business, BusinessMember } from './business/businessSchema.js';
import Customer from './commerce/customerSchema.js';
import { Order, OrderItem } from './commerce/orderSchema.js';
import PaymentLink from './commerce/paymentLinkSchema.js';
import PaymentAttempt from './payments/paymentAttemptSchema.js';
import ProviderEvent from './payments/providerEventSchema.js';
import Settlement from './payments/settlementSchema.js';
import DemoProviderObject from './payments/demoProviderObjectSchema.js';
import AuditEvent from './audit/auditEventSchema.js';
import EmailOutbox from './notifications/emailOutboxSchema.js';

const noFk = { constraints: false } as const;

BusinessMember.belongsTo(Business, { as: 'business', foreignKey: 'businessId', ...noFk });
BusinessMember.belongsTo(Auth, { as: 'user', foreignKey: 'userId', ...noFk });

Order.belongsTo(Customer, { as: 'customer', foreignKey: 'customerId', ...noFk });
Order.hasMany(OrderItem, { as: 'items', foreignKey: 'orderId', ...noFk });
Order.hasMany(PaymentLink, { as: 'links', foreignKey: 'orderId', ...noFk });
Order.hasMany(PaymentAttempt, { as: 'attempts', foreignKey: 'orderId', ...noFk });
Customer.hasMany(Order, { as: 'orders', foreignKey: 'customerId', ...noFk });

PaymentLink.belongsTo(Order, { as: 'order', foreignKey: 'orderId', ...noFk });
PaymentAttempt.belongsTo(Order, { as: 'order', foreignKey: 'orderId', ...noFk });
PaymentAttempt.belongsTo(PaymentLink, { as: 'link', foreignKey: 'paymentLinkId', ...noFk });
Settlement.belongsTo(Order, { as: 'order', foreignKey: 'orderId', ...noFk });
Settlement.belongsTo(PaymentAttempt, { as: 'attempt', foreignKey: 'paymentAttemptId', ...noFk });

export {
  Auth,
  AuthSession,
  AuthToken,
  Business,
  BusinessMember,
  Customer,
  Order,
  OrderItem,
  PaymentLink,
  PaymentAttempt,
  ProviderEvent,
  Settlement,
  DemoProviderObject,
  AuditEvent,
  EmailOutbox,
};

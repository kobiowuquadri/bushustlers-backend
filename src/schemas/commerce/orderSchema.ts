import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute } from 'sequelize';
import sequelize from '../../database/db.js';
import type { Customer } from './customerSchema.js';

export type OrderStatus = 'draft' | 'open' | 'expired' | 'cancelled';
// Payment and fulfilment are tracked separately: "paid" never implies "dispatched"
export type OrderPaymentStatus = 'unpaid' | 'processing' | 'paid' | 'needs_review';
export type FulfilmentStatus = 'unfulfilled' | 'dispatched' | 'delivered';

// Money columns are BIGINT minor units (kobo), read back as strings and handled with BigInt.
export class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  declare id: CreationOptional<number>;
  declare publicId: string;
  declare businessId: number;
  declare customerId: number | null;
  declare reference: string;
  declare status: CreationOptional<OrderStatus>;
  declare paymentStatus: CreationOptional<OrderPaymentStatus>;
  // Set when a confirmed order also has a payment that needs a decision, e.g. a second payment
  declare reviewRequired: CreationOptional<boolean>;
  declare fulfilmentStatus: CreationOptional<FulfilmentStatus>;
  declare currency: CreationOptional<string>;
  declare subtotalMinor: string;
  declare deliveryFeeMinor: string;
  declare totalMinor: string;
  declare amountPaidMinor: CreationOptional<string>;
  declare note: string | null;
  declare fulfilmentNote: CreationOptional<string | null>;
  declare paidAt: CreationOptional<Date | null>;
  declare dispatchedAt: CreationOptional<Date | null>;
  declare deliveredAt: CreationOptional<Date | null>;
  declare cancelledAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare items?: NonAttribute<OrderItem[]>;
  declare customer?: NonAttribute<Customer | null>;
}

Order.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    publicId: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false },
    customerId: { type: DataTypes.INTEGER, allowNull: true },
    reference: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.ENUM('draft', 'open', 'expired', 'cancelled'), allowNull: false, defaultValue: 'draft' },
    paymentStatus: { type: DataTypes.ENUM('unpaid', 'processing', 'paid', 'needs_review'), allowNull: false, defaultValue: 'unpaid' },
    reviewRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    fulfilmentStatus: { type: DataTypes.ENUM('unfulfilled', 'dispatched', 'delivered'), allowNull: false, defaultValue: 'unfulfilled' },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'NGN' },
    subtotalMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    deliveryFeeMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    totalMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    amountPaidMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    note: { type: DataTypes.STRING(500), allowNull: true },
    fulfilmentNote: { type: DataTypes.STRING(255), allowNull: true },
    paidAt: { type: DataTypes.DATE(3), allowNull: true },
    dispatchedAt: { type: DataTypes.DATE(3), allowNull: true },
    deliveredAt: { type: DataTypes.DATE(3), allowNull: true },
    cancelledAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'Order', tableName: 'orders' },
);

export class OrderItem extends Model<InferAttributes<OrderItem>, InferCreationAttributes<OrderItem>> {
  declare id: CreationOptional<number>;
  declare orderId: number;
  declare name: string;
  declare quantity: number;
  declare unitPriceMinor: string;
  declare lineTotalMinor: string;
  declare position: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

OrderItem.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    orderId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    unitPriceMinor: { type: DataTypes.BIGINT, allowNull: false },
    lineTotalMinor: { type: DataTypes.BIGINT, allowNull: false },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'OrderItem', tableName: 'order_items' },
);

import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type NonAttribute } from 'sequelize';
import sequelize from '../../database/db.js';
import type { Order } from './orderSchema.js';

export type PaymentLinkStatus = 'active' | 'disabled' | 'expired' | 'completed';

// An order-specific checkout link. publicId is an unguessable capability used in the /pay/:id URL.
export class PaymentLink extends Model<InferAttributes<PaymentLink>, InferCreationAttributes<PaymentLink>> {
  declare id: CreationOptional<number>;
  declare publicId: string;
  declare businessId: number;
  declare orderId: number;
  declare status: CreationOptional<PaymentLinkStatus>;
  declare expiresAt: Date;
  declare disabledAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare order?: NonAttribute<Order>;
}

PaymentLink.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    publicId: { type: DataTypes.STRING(22), allowNull: false, unique: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false },
    orderId: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'disabled', 'expired', 'completed'), allowNull: false, defaultValue: 'active' },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    disabledAt: { type: DataTypes.DATE(3), allowNull: true },
    completedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'PaymentLink', tableName: 'payment_links' },
);

export default PaymentLink;

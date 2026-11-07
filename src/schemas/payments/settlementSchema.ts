import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

export type SettlementStatus = 'pending' | 'settled' | 'failed';

// Created when a payment is confirmed. A confirmed payment is NOT money in the merchant's bank:
// status only becomes "settled" with payout evidence (or an explicit, labelled demo simulation).
export class Settlement extends Model<InferAttributes<Settlement>, InferCreationAttributes<Settlement>> {
  declare id: CreationOptional<number>;
  declare publicId: string;
  declare businessId: number;
  declare orderId: number;
  declare paymentAttemptId: number;
  declare status: CreationOptional<SettlementStatus>;
  declare currency: CreationOptional<string>;
  declare grossMinor: string;
  declare providerFeeMinor: CreationOptional<string>;
  declare platformFeeMinor: CreationOptional<string>;
  declare netMinor: string;
  declare feeBasis: string;
  declare payoutReference: CreationOptional<string | null>;
  declare settledAt: CreationOptional<Date | null>;
  declare failureReason: CreationOptional<string | null>;
  declare simulated: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Settlement.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    publicId: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false },
    orderId: { type: DataTypes.INTEGER, allowNull: false },
    paymentAttemptId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('pending', 'settled', 'failed'), allowNull: false, defaultValue: 'pending' },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'NGN' },
    grossMinor: { type: DataTypes.BIGINT, allowNull: false },
    providerFeeMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    platformFeeMinor: { type: DataTypes.BIGINT, allowNull: false, defaultValue: '0' },
    netMinor: { type: DataTypes.BIGINT, allowNull: false },
    feeBasis: { type: DataTypes.STRING(120), allowNull: false },
    payoutReference: { type: DataTypes.STRING(80), allowNull: true },
    settledAt: { type: DataTypes.DATE(3), allowNull: true },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    simulated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'Settlement', tableName: 'settlements' },
);

export default Settlement;

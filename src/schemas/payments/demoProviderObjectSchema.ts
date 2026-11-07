import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

// Explicit local demo mode only: plays the part of the provider's records so the full
// webhook → lookup → reconcile pipeline runs without a real provider. Never used with Busha.
export class DemoProviderObject extends Model<InferAttributes<DemoProviderObject>, InferCreationAttributes<DemoProviderObject>> {
  declare id: CreationOptional<number>;
  declare providerReference: string;
  declare kind: 'transfer' | 'payment_request';
  declare status: string;
  declare reference: string;
  declare requestedAmount: string;
  declare requestedCurrency: string;
  declare sourceAmount: string;
  declare sourceCurrency: string;
  declare targetAmount: string;
  declare targetCurrency: string;
  declare receivedAmount: CreationOptional<string | null>;
  declare network: string | null;
  declare address: string | null;
  declare expiresAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

DemoProviderObject.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    providerReference: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    kind: { type: DataTypes.ENUM('transfer', 'payment_request'), allowNull: false },
    status: { type: DataTypes.STRING(40), allowNull: false },
    reference: { type: DataTypes.STRING(64), allowNull: false },
    requestedAmount: { type: DataTypes.STRING(40), allowNull: false },
    requestedCurrency: { type: DataTypes.STRING(10), allowNull: false },
    sourceAmount: { type: DataTypes.STRING(40), allowNull: false },
    sourceCurrency: { type: DataTypes.STRING(10), allowNull: false },
    targetAmount: { type: DataTypes.STRING(40), allowNull: false },
    targetCurrency: { type: DataTypes.STRING(10), allowNull: false },
    receivedAmount: { type: DataTypes.STRING(40), allowNull: true },
    network: { type: DataTypes.STRING(16), allowNull: true },
    address: { type: DataTypes.STRING(120), allowNull: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'DemoProviderObject', tableName: 'demo_provider_objects' },
);

export default DemoProviderObject;

import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';
import type { PaymentProviderName } from './paymentAttemptSchema.js';

export type ProviderEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

// Every authenticated provider notification is stored before it is acknowledged.
// Busha events carry no event id, so dedupeKey is the SHA-256 of the exact raw body.
export class ProviderEvent extends Model<InferAttributes<ProviderEvent>, InferCreationAttributes<ProviderEvent>> {
  declare id: CreationOptional<number>;
  declare provider: PaymentProviderName;
  declare dedupeKey: string;
  declare eventType: string;
  declare objectType: string | null;
  declare objectId: string | null;
  declare paymentAttemptId: CreationOptional<number | null>;
  declare payload: unknown;
  declare status: CreationOptional<ProviderEventStatus>;
  declare processingAttempts: CreationOptional<number>;
  declare lastError: CreationOptional<string | null>;
  declare receivedAt: Date;
  declare processedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ProviderEvent.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    provider: { type: DataTypes.ENUM('busha', 'demo'), allowNull: false },
    dedupeKey: { type: DataTypes.STRING(64), allowNull: false },
    eventType: { type: DataTypes.STRING(64), allowNull: false },
    objectType: { type: DataTypes.STRING(32), allowNull: true },
    objectId: { type: DataTypes.STRING(80), allowNull: true },
    paymentAttemptId: { type: DataTypes.INTEGER, allowNull: true },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM('received', 'processed', 'ignored', 'failed'), allowNull: false, defaultValue: 'received' },
    processingAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.STRING(255), allowNull: true },
    receivedAt: { type: DataTypes.DATE(3), allowNull: false },
    processedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'ProviderEvent', tableName: 'provider_events' },
);

export default ProviderEvent;

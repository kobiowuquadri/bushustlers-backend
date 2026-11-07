import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

export type ActorType = 'user' | 'buyer' | 'provider' | 'system';

// Append-only history of state changes. Drives the order timeline and payment audit trail.
export class AuditEvent extends Model<InferAttributes<AuditEvent>, InferCreationAttributes<AuditEvent>> {
  declare id: CreationOptional<number>;
  declare businessId: number | null;
  declare orderId: number | null;
  declare entityType: string;
  declare entityId: number | null;
  declare action: string;
  declare actorType: ActorType;
  declare actorId: number | null;
  declare fromStatus: string | null;
  declare toStatus: string | null;
  declare metadata: Record<string, unknown> | null;
  declare requestId: string | null;
  declare createdAt: CreationOptional<Date>;
}

AuditEvent.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId: { type: DataTypes.INTEGER, allowNull: true },
    orderId: { type: DataTypes.INTEGER, allowNull: true },
    entityType: { type: DataTypes.STRING(32), allowNull: false },
    entityId: { type: DataTypes.INTEGER, allowNull: true },
    action: { type: DataTypes.STRING(64), allowNull: false },
    actorType: { type: DataTypes.ENUM('user', 'buyer', 'provider', 'system'), allowNull: false },
    actorId: { type: DataTypes.INTEGER, allowNull: true },
    fromStatus: { type: DataTypes.STRING(40), allowNull: true },
    toStatus: { type: DataTypes.STRING(40), allowNull: true },
    metadata: { type: DataTypes.JSON, allowNull: true },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'AuditEvent', tableName: 'audit_events', updatedAt: false },
);

export default AuditEvent;

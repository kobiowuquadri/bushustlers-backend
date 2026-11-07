import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

// One row per signed-in device. Only SHA-256 hashes of refresh tokens are stored.
export class AuthSession extends Model<InferAttributes<AuthSession>, InferCreationAttributes<AuthSession>> {
  declare id: CreationOptional<number>;
  declare publicId: string;
  declare userId: number;
  declare refreshTokenHash: string;
  // The token replaced by the latest rotation stays valid for a few seconds so parallel tabs don't sign each other out
  declare previousTokenHash: CreationOptional<string | null>;
  declare rotatedAt: CreationOptional<Date | null>;
  declare userAgent: string | null;
  declare ipAddress: string | null;
  declare expiresAt: Date;
  declare lastUsedAt: CreationOptional<Date | null>;
  declare revokedAt: CreationOptional<Date | null>;
  declare revokedReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

AuthSession.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    publicId: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    refreshTokenHash: { type: DataTypes.STRING(64), allowNull: false },
    previousTokenHash: { type: DataTypes.STRING(64), allowNull: true },
    rotatedAt: { type: DataTypes.DATE(3), allowNull: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
    revokedAt: { type: DataTypes.DATE(3), allowNull: true },
    revokedReason: { type: DataTypes.STRING(40), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'AuthSession', tableName: 'auth_sessions' },
);

export default AuthSession;

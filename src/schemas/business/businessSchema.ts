import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

export type ProviderVerificationStatus = 'not_started' | 'pending' | 'verified' | 'rejected';

export class Business extends Model<InferAttributes<Business>, InferCreationAttributes<Business>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare category: string;
  declare phone: string | null;
  // Order references look like AMK-104
  declare orderPrefix: string;
  declare nextOrderNumber: CreationOptional<number>;
  declare settlementPreference: CreationOptional<string>;
  declare notifyPaymentEmails: CreationOptional<boolean>;
  declare notifyReviewEmails: CreationOptional<boolean>;
  // Only ever changed from authoritative provider data; never set by the merchant
  declare providerVerificationStatus: CreationOptional<ProviderVerificationStatus>;
  declare providerVerifiedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Business.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    category: { type: DataTypes.STRING(40), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    orderPrefix: { type: DataTypes.STRING(5), allowNull: false },
    nextOrderNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 101 },
    settlementPreference: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'naira' },
    notifyPaymentEmails: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notifyReviewEmails: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    providerVerificationStatus: {
      type: DataTypes.ENUM('not_started', 'pending', 'verified', 'rejected'),
      allowNull: false,
      defaultValue: 'not_started',
    },
    providerVerifiedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'Business', tableName: 'businesses' },
);

export type MemberRole = 'owner' | 'staff';

export class BusinessMember extends Model<InferAttributes<BusinessMember>, InferCreationAttributes<BusinessMember>> {
  declare id: CreationOptional<number>;
  declare businessId: number;
  declare userId: number;
  declare role: CreationOptional<MemberRole>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

BusinessMember.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.ENUM('owner', 'staff'), allowNull: false, defaultValue: 'owner' },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'BusinessMember', tableName: 'business_members' },
);

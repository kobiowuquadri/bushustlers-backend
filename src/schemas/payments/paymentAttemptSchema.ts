import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import sequelize from '../../database/db.js';

export type PaymentRoute = 'bank_transfer' | 'stablecoin';
export type PaymentProviderName = 'busha' | 'demo';
export type ProviderMode = 'demo' | 'sandbox' | 'production';
export type AttemptStatus =
  | 'creating'
  | 'awaiting_payment'
  | 'processing'
  | 'confirmed'
  | 'needs_review'
  | 'failed'
  | 'expired'
  | 'cancelled';
export type ReviewReason =
  | 'underpayment'
  | 'overpayment'
  | 'multiple_deposits'
  | 'late_payment'
  | 'duplicate_payment'
  | 'currency_mismatch'
  | 'reference_mismatch';

export interface ProviderFee {
  name: string;
  amount: string;
  currency: string;
  type?: string;
}

export interface BankTransferInstructions {
  kind: 'bank_transfer';
  bankName: string;
  accountNumber: string;
  accountName: string;
  amount: string; // NGN, major units
  currency: 'NGN';
  expiresAt: string | null;
  demo: boolean;
}

export interface StablecoinInstructions {
  kind: 'stablecoin';
  asset: string;
  network: string;
  networkLabel: string;
  address: string;
  memo: string | null;
  amount: string; // exact asset amount the buyer must send
  rate: string | null;
  rateExplained: string | null;
  rateSource: 'provider_quote' | 'demo';
  quoteExpiresAt: string | null;
  demo: boolean;
}

export type PaymentInstructions = BankTransferInstructions | StablecoinInstructions;

// One buyer attempt to pay an order through one route. An order can have several attempts;
// financial state only changes through the reconciliation service after provider verification.
export class PaymentAttempt extends Model<InferAttributes<PaymentAttempt>, InferCreationAttributes<PaymentAttempt>> {
  declare id: CreationOptional<number>;
  declare publicId: string;
  declare businessId: number;
  declare orderId: number;
  declare paymentLinkId: number;
  declare route: PaymentRoute;
  declare provider: PaymentProviderName;
  declare providerMode: ProviderMode;
  declare reference: string;
  declare idempotencyKey: string;
  declare providerReference: CreationOptional<string | null>;
  declare providerStatus: CreationOptional<string | null>;
  declare status: CreationOptional<AttemptStatus>;
  declare reviewReason: CreationOptional<ReviewReason | null>;
  declare reviewResolution: CreationOptional<string | null>;
  declare resolutionNote: CreationOptional<string | null>;
  declare resolvedAt: CreationOptional<Date | null>;
  declare resolvedBy: CreationOptional<number | null>;
  declare currency: CreationOptional<string>;
  declare expectedAmountMinor: string;
  declare asset: CreationOptional<string | null>;
  declare network: CreationOptional<string | null>;
  declare assetAmount: CreationOptional<string | null>;
  declare rate: CreationOptional<string | null>;
  declare rateSource: CreationOptional<string | null>;
  declare payInAccountNumber: CreationOptional<string | null>;
  declare instructions: CreationOptional<PaymentInstructions | null>;
  declare receivedAmount: CreationOptional<string | null>;
  declare receivedCurrency: CreationOptional<string | null>;
  declare receivedAmountMinor: CreationOptional<string | null>;
  declare settlementAmount: CreationOptional<string | null>;
  declare settlementCurrency: CreationOptional<string | null>;
  declare providerFees: CreationOptional<ProviderFee[] | null>;
  declare buyerEmail: CreationOptional<string | null>;
  declare buyerName: CreationOptional<string | null>;
  declare expiresAt: CreationOptional<Date | null>;
  declare confirmedAt: CreationOptional<Date | null>;
  declare failedAt: CreationOptional<Date | null>;
  declare lastCheckedAt: CreationOptional<Date | null>;
  declare checkCount: CreationOptional<number>;
  declare failureReason: CreationOptional<string | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PaymentAttempt.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    publicId: { type: DataTypes.STRING(24), allowNull: false, unique: true },
    businessId: { type: DataTypes.INTEGER, allowNull: false },
    orderId: { type: DataTypes.INTEGER, allowNull: false },
    paymentLinkId: { type: DataTypes.INTEGER, allowNull: false },
    route: { type: DataTypes.ENUM('bank_transfer', 'stablecoin'), allowNull: false },
    provider: { type: DataTypes.ENUM('busha', 'demo'), allowNull: false },
    providerMode: { type: DataTypes.ENUM('demo', 'sandbox', 'production'), allowNull: false },
    reference: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    idempotencyKey: { type: DataTypes.STRING(80), allowNull: false },
    providerReference: { type: DataTypes.STRING(80), allowNull: true },
    providerStatus: { type: DataTypes.STRING(40), allowNull: true },
    status: {
      type: DataTypes.ENUM('creating', 'awaiting_payment', 'processing', 'confirmed', 'needs_review', 'failed', 'expired', 'cancelled'),
      allowNull: false,
      defaultValue: 'creating',
    },
    reviewReason: { type: DataTypes.STRING(40), allowNull: true },
    reviewResolution: { type: DataTypes.STRING(20), allowNull: true },
    resolutionNote: { type: DataTypes.STRING(500), allowNull: true },
    resolvedAt: { type: DataTypes.DATE(3), allowNull: true },
    resolvedBy: { type: DataTypes.INTEGER, allowNull: true },
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'NGN' },
    expectedAmountMinor: { type: DataTypes.BIGINT, allowNull: false },
    asset: { type: DataTypes.STRING(10), allowNull: true },
    network: { type: DataTypes.STRING(16), allowNull: true },
    assetAmount: { type: DataTypes.STRING(40), allowNull: true },
    rate: { type: DataTypes.STRING(40), allowNull: true },
    rateSource: { type: DataTypes.STRING(20), allowNull: true },
    payInAccountNumber: { type: DataTypes.STRING(20), allowNull: true },
    instructions: { type: DataTypes.JSON, allowNull: true },
    receivedAmount: { type: DataTypes.STRING(40), allowNull: true },
    receivedCurrency: { type: DataTypes.STRING(10), allowNull: true },
    receivedAmountMinor: { type: DataTypes.BIGINT, allowNull: true },
    settlementAmount: { type: DataTypes.STRING(40), allowNull: true },
    settlementCurrency: { type: DataTypes.STRING(10), allowNull: true },
    providerFees: { type: DataTypes.JSON, allowNull: true },
    buyerEmail: { type: DataTypes.STRING(255), allowNull: true },
    buyerName: { type: DataTypes.STRING(120), allowNull: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: true },
    confirmedAt: { type: DataTypes.DATE(3), allowNull: true },
    failedAt: { type: DataTypes.DATE(3), allowNull: true },
    lastCheckedAt: { type: DataTypes.DATE(3), allowNull: true },
    checkCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    createdAt: { type: DataTypes.DATE(3), allowNull: false },
    updatedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'PaymentAttempt', tableName: 'payment_attempts' },
);

export default PaymentAttempt;

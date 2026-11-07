import sequelize from '../../database/db.js';
import { config } from '../../config/config.js';
import { BUSINESS_CATEGORIES, SETTLEMENT_PREFERENCES, suggestOrderPrefix } from '../../constants/business.js';
import { Auth, Business, BusinessMember } from '../../schemas/index.js';
import { getPaymentProvider } from '../../modules/payments/index.js';
import { emailDeliveryMode } from '../../modules/notifications/mailer.js';
import { recordAudit } from '../audit/auditService.js';
import { appError, messageHandler } from '../../utils/index.js';
import { CONFLICT, CREATED, SUCCESS, VALIDATION_ERROR } from '../../constants/statusCode.js';

export interface CreateBusinessInput {
  ownerName?: string;
  businessName: string;
  category: keyof typeof BUSINESS_CATEGORIES;
  phone?: string | null;
  settlementPreference?: string;
  orderPrefix?: string;
}

export interface UpdateBusinessInput {
  businessName?: string;
  category?: keyof typeof BUSINESS_CATEGORIES;
  phone?: string | null;
  orderPrefix?: string;
  settlementPreference?: string;
  notifyPaymentEmails?: boolean;
  notifyReviewEmails?: boolean;
}

const assertSettlementPreference = (value: string | undefined) => {
  if (value === undefined) return;
  const option = SETTLEMENT_PREFERENCES[value as keyof typeof SETTLEMENT_PREFERENCES];
  if (!option || !option.available) {
    throw appError(VALIDATION_ERROR, 'unsupported_settlement', 'That settlement option is not available yet', {
      errors: [{ field: 'settlementPreference', message: 'Only naira settlement is available in this release' }],
    });
  }
};

// What the merchant needs to know about the environment they are working in
export const environmentStatus = () => {
  const provider = getPaymentProvider();
  return {
    appEnv: config.app.env,
    payments: {
      provider: provider.name,
      mode: provider.mode,
      bankTransfer: provider.capabilities.bankTransfer,
      stablecoin: provider.capabilities.stablecoin,
      stablecoinOptions: provider.stablecoinOptions(),
      sandboxDepositSimulation: provider.capabilities.sandboxDepositSimulation && config.payments.demoToolsEnabled,
      demoTools: provider.capabilities.demoSimulation && config.payments.demoToolsEnabled,
      settlementPayouts: false,
    },
    email: { delivery: emailDeliveryMode() },
    fees: config.fees,
  };
};

export const businessResponse = (business: Business) => ({
  name: business.name,
  category: business.category,
  categoryLabel: BUSINESS_CATEGORIES[business.category as keyof typeof BUSINESS_CATEGORIES] ?? business.category,
  phone: business.phone,
  orderPrefix: business.orderPrefix,
  nextOrderReference: `${business.orderPrefix}-${business.nextOrderNumber}`,
  settlementPreference: business.settlementPreference,
  notifications: {
    paymentEmails: business.notifyPaymentEmails,
    reviewEmails: business.notifyReviewEmails,
  },
  // Set only from authoritative provider data. Bushustlers does not run provider verification in this release.
  providerVerification: {
    status: business.providerVerificationStatus,
    verifiedAt: business.providerVerifiedAt,
  },
  createdAt: business.createdAt,
});

export const createBusinessService = async (userId: number, input: CreateBusinessInput, requestId?: string) => {
  assertSettlementPreference(input.settlementPreference);
  const existing = await BusinessMember.findOne({ where: { userId } });
  if (existing) throw appError(CONFLICT, 'business_exists', 'Your business is already set up');

  const business = await sequelize.transaction(async (transaction) => {
    const created = await Business.create(
      {
        name: input.businessName,
        category: input.category,
        phone: input.phone || null,
        orderPrefix: input.orderPrefix || suggestOrderPrefix(input.businessName),
        settlementPreference: input.settlementPreference || 'naira',
      },
      { transaction },
    );
    await BusinessMember.create({ businessId: created.id, userId, role: 'owner' }, { transaction });
    if (input.ownerName) await Auth.update({ fullName: input.ownerName }, { where: { id: userId }, transaction });
    await recordAudit({ businessId: created.id, entityType: 'business', entityId: created.id, action: 'business.created', actor: { type: 'user', id: userId }, requestId }, transaction);
    return created;
  });

  return messageHandler('Business set up', true, CREATED, { business: businessResponse(business), environment: environmentStatus() });
};

export const getBusinessService = async (business: Business) =>
  messageHandler('Business retrieved', true, SUCCESS, { business: businessResponse(business), environment: environmentStatus(), categories: BUSINESS_CATEGORIES, settlementOptions: SETTLEMENT_PREFERENCES });

export const updateBusinessService = async (business: Business, input: UpdateBusinessInput, userId: number, requestId?: string) => {
  assertSettlementPreference(input.settlementPreference);
  const patch: Partial<Business> = {};
  if (input.businessName !== undefined) patch.name = input.businessName;
  if (input.category !== undefined) patch.category = input.category;
  if (input.phone !== undefined) patch.phone = input.phone || null;
  if (input.orderPrefix !== undefined) patch.orderPrefix = input.orderPrefix;
  if (input.settlementPreference !== undefined) patch.settlementPreference = input.settlementPreference;
  if (input.notifyPaymentEmails !== undefined) patch.notifyPaymentEmails = input.notifyPaymentEmails;
  if (input.notifyReviewEmails !== undefined) patch.notifyReviewEmails = input.notifyReviewEmails;
  await business.update(patch);
  await recordAudit({ businessId: business.id, entityType: 'business', entityId: business.id, action: 'business.updated', actor: { type: 'user', id: userId }, metadata: { fields: Object.keys(patch) }, requestId });
  return messageHandler('Business settings saved', true, SUCCESS, { business: businessResponse(business) });
};

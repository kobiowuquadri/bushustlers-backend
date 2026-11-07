import type { Schema } from 'express-validator';
import { BUSINESS_CATEGORIES } from '../constants/business.js';
import { ORDER_VIEWS } from '../services/commerce/orderService.js';
import { LINK_TTL_OPTIONS_HOURS } from '../services/commerce/paymentLinkService.js';
import { OVERVIEW_PERIODS } from '../services/overviewService.js';
import { optionalEmail, optionalPhone, optionalString, paginationQuery, publicIdParam, linkIdParam, requiredString } from './common.js';

const MINOR = /^\d{1,13}$/;

const category = (optional: boolean): Schema[string] => ({
  in: ['body'],
  ...(optional ? { optional: true } : {}),
  isIn: { options: [Object.keys(BUSINESS_CATEGORIES)], errorMessage: 'Choose a business category' },
});

const orderPrefix: Schema[string] = {
  in: ['body'],
  optional: true,
  isString: { errorMessage: 'Use 2-5 letters', bail: true },
  trim: true,
  toUpperCase: true,
  matches: { options: [/^[A-Z]{2,5}$/], errorMessage: 'Use 2-5 letters, e.g. AMK' },
};

// ---- Business -------------------------------------------------------------------------------
export const createBusinessValidation: Schema = {
  ownerName: { ...optionalString(120, 'Enter your full name'), isLength: { options: { min: 2, max: 120 }, errorMessage: 'Enter your full name' } },
  businessName: requiredString(2, 120, 'Enter your business name (2-120 characters)'),
  category: category(false),
  phone: optionalPhone(),
  settlementPreference: { in: ['body'], optional: true, isIn: { options: [['naira', 'stablecoin']], errorMessage: 'Choose a settlement option' } },
  orderPrefix,
};

export const updateBusinessValidation: Schema = {
  businessName: { ...requiredString(2, 120, 'Enter your business name (2-120 characters)'), optional: true },
  category: category(true),
  phone: optionalPhone(),
  orderPrefix,
  settlementPreference: { in: ['body'], optional: true, isIn: { options: [['naira', 'stablecoin']], errorMessage: 'Choose a settlement option' } },
  notifyPaymentEmails: { in: ['body'], optional: true, isBoolean: { errorMessage: 'Must be true or false' }, toBoolean: true },
  notifyReviewEmails: { in: ['body'], optional: true, isBoolean: { errorMessage: 'Must be true or false' }, toBoolean: true },
};

// ---- Customers ------------------------------------------------------------------------------
export const customerIdValidation: Schema = { customerId: publicIdParam('customerId', 'cus') };

export const listCustomersValidation: Schema = {
  ...paginationQuery,
  search: optionalString(100, 'Search is too long', 'query'),
};

export const updateCustomerValidation: Schema = {
  customerId: publicIdParam('customerId', 'cus'),
  name: { ...requiredString(2, 120, 'Enter the customer name'), optional: true },
  email: optionalEmail,
  phone: optionalPhone(),
  handle: optionalString(80, 'Handle is too long'),
};

// ---- Orders ---------------------------------------------------------------------------------
export const orderIdValidation: Schema = { orderId: publicIdParam('orderId', 'ord') };

export const orderBodyValidation: Schema = {
  customer: {
    in: ['body'],
    optional: { options: { values: 'null' } },
    isObject: { errorMessage: 'Invalid customer' },
    custom: {
      options: (value: { id?: unknown; name?: unknown }) => {
        if (value && !value.id && !value.name) throw new Error('Choose a customer or enter their name');
        return true;
      },
    },
  },
  'customer.id': { in: ['body'], optional: true, matches: { options: [/^cus_[0-9A-Za-z]{20}$/], errorMessage: 'Customer not found' } },
  'customer.name': { in: ['body'], optional: true, isString: { errorMessage: 'Enter the customer name', bail: true }, trim: true, isLength: { options: { min: 2, max: 120 }, errorMessage: 'Enter the customer name (2-120 characters)' } },
  'customer.email': { ...optionalEmail },
  'customer.phone': optionalPhone(),
  'customer.handle': optionalString(80, 'Handle is too long'),
  items: {
    in: ['body'],
    isArray: { options: { min: 1, max: 50 }, errorMessage: 'Add between 1 and 50 items' },
  },
  'items.*.name': { in: ['body'], isString: { errorMessage: 'Enter an item name', bail: true }, trim: true, isLength: { options: { min: 1, max: 120 }, errorMessage: 'Enter an item name (up to 120 characters)' } },
  'items.*.quantity': { in: ['body'], isInt: { options: { min: 1, max: 10000 }, errorMessage: 'Quantity must be between 1 and 10,000' }, toInt: true },
  'items.*.unitPriceMinor': {
    in: ['body'],
    custom: {
      options: (value: unknown) => {
        const text = typeof value === 'number' ? String(value) : value;
        if (typeof text !== 'string' || !MINOR.test(text) || BigInt(text) <= 0n) throw new Error('Enter a price above ₦0');
        return true;
      },
    },
    customSanitizer: { options: (value: unknown) => String(value) },
  },
  deliveryFeeMinor: {
    in: ['body'],
    optional: { options: { values: 'null' } },
    custom: {
      options: (value: unknown) => {
        const text = typeof value === 'number' ? String(value) : value;
        if (typeof text !== 'string' || !MINOR.test(text)) throw new Error('Enter a valid delivery charge');
        return true;
      },
    },
    customSanitizer: { options: (value: unknown) => (value === null || value === undefined ? undefined : String(value)) },
  },
  note: optionalString(500, 'Notes can be up to 500 characters'),
};

export const updateOrderValidation: Schema = { ...orderIdValidation, ...orderBodyValidation };

export const listOrdersValidation: Schema = {
  ...paginationQuery,
  view: { in: ['query'], optional: true, isIn: { options: [ORDER_VIEWS], errorMessage: 'Invalid filter' } },
  search: optionalString(100, 'Search is too long', 'query'),
  customer: { in: ['query'], optional: true, matches: { options: [/^cus_[0-9A-Za-z]{20}$/], errorMessage: 'Invalid customer' } },
};

export const fulfilmentValidation: Schema = {
  ...orderIdValidation,
  status: { in: ['body'], isIn: { options: [['dispatched', 'delivered']], errorMessage: 'Choose dispatched or delivered' } },
  note: optionalString(255, 'Notes can be up to 255 characters'),
};

export const createLinkValidation: Schema = {
  ...orderIdValidation,
  // Validators see values as strings, so 72 and "72" are both accepted before toInt converts them
  expiresInHours: { in: ['body'], optional: true, isIn: { options: [LINK_TTL_OPTIONS_HOURS.map(String)], errorMessage: 'Choose 24 hours, 3 days or 7 days' }, toInt: true },
};

// ---- Links ----------------------------------------------------------------------------------
export const linkIdValidation: Schema = { linkId: linkIdParam };
export const listLinksValidation: Schema = {
  ...paginationQuery,
  status: { in: ['query'], optional: true, isIn: { options: [['active', 'expired', 'disabled', 'completed']], errorMessage: 'Invalid filter' } },
};

// ---- Transactions & settlements -------------------------------------------------------------
export const transactionIdValidation: Schema = { transactionId: publicIdParam('transactionId', 'pat') };

export const listTransactionsValidation: Schema = {
  ...paginationQuery,
  status: { in: ['query'], optional: true, isIn: { options: [['awaiting_payment', 'processing', 'confirmed', 'needs_review', 'failed', 'expired', 'cancelled']], errorMessage: 'Invalid filter' } },
  route: { in: ['query'], optional: true, isIn: { options: [['bank_transfer', 'stablecoin']], errorMessage: 'Invalid filter' } },
  search: optionalString(100, 'Search is too long', 'query'),
};

export const resolveReviewValidation: Schema = {
  ...transactionIdValidation,
  decision: { in: ['body'], isIn: { options: [['accept', 'hold']], errorMessage: 'Choose accept or hold' } },
  note: optionalString(500, 'Notes can be up to 500 characters'),
};

export const simulatePaymentValidation: Schema = {
  ...transactionIdValidation,
  outcome: { in: ['body'], isIn: { options: [['paid', 'underpaid', 'overpaid', 'processing', 'failed', 'expired']], errorMessage: 'Choose an outcome' } },
};

export const listSettlementsValidation: Schema = {
  ...paginationQuery,
  status: { in: ['query'], optional: true, isIn: { options: [['pending', 'settled', 'failed']], errorMessage: 'Invalid filter' } },
};

export const simulateSettlementValidation: Schema = {
  settlementId: publicIdParam('settlementId', 'stl'),
  outcome: { in: ['body'], isIn: { options: [['settled', 'failed']], errorMessage: 'Choose settled or failed' } },
};

export const overviewValidation: Schema = {
  period: { in: ['query'], optional: true, isIn: { options: [Object.keys(OVERVIEW_PERIODS)], errorMessage: 'Invalid period' } },
};

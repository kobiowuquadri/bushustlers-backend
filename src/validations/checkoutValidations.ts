import type { Meta, Schema } from 'express-validator';
import { linkIdParam, optionalString, publicIdParam } from './common.js';

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const isStablecoin = (meta: Meta) => meta.req.body?.route === 'stablecoin';

export const checkoutLinkValidation: Schema = { linkId: linkIdParam };

export const startPaymentValidation: Schema = {
  linkId: linkIdParam,
  'idempotency-key': {
    in: ['headers'],
    matches: { options: [/^[A-Za-z0-9_-]{16,80}$/], errorMessage: 'Missing or invalid Idempotency-Key header' },
  },
  route: { in: ['body'], isIn: { options: [['bank_transfer', 'stablecoin']], errorMessage: 'Choose a payment method' } },
  // Asset and network are only required (and only accepted) for stablecoin payments
  asset: {
    in: ['body'],
    custom: {
      options: (value: unknown, meta: Meta) => {
        if (!isStablecoin(meta)) return true;
        if (!['USDT', 'USDC'].includes(String(upper(value)))) throw new Error('Choose a supported stablecoin');
        return true;
      },
    },
    customSanitizer: { options: (value: unknown, meta: Meta) => (isStablecoin(meta) ? upper(value) : undefined) },
  },
  network: {
    in: ['body'],
    custom: {
      options: (value: unknown, meta: Meta) => {
        if (!isStablecoin(meta)) return true;
        if (!/^[A-Z]{2,10}$/.test(String(upper(value)))) throw new Error('Choose a supported network');
        return true;
      },
    },
    customSanitizer: { options: (value: unknown, meta: Meta) => (isStablecoin(meta) ? upper(value) : undefined) },
  },
  email: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    trim: true,
    isEmail: { errorMessage: 'Enter a valid email address' },
    isLength: { options: { max: 255 }, errorMessage: 'Email is too long' },
    toLowerCase: true,
  },
  name: optionalString(120, 'Name is too long'),
};

export const attemptValidation: Schema = {
  linkId: linkIdParam,
  attemptId: publicIdParam('attemptId', 'pat'),
};

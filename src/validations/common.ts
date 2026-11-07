import type { Schema } from 'express-validator';
import { LINK_ID_PATTERN } from '../utils/ids.js';
import { normalizePhone } from '../utils/phone.js';

export const optionalString = (max: number, message: string, location: 'body' | 'query' = 'body'): Schema[string] => ({
  in: [location],
  optional: { options: { values: 'null' } },
  isString: { errorMessage: message, bail: true },
  trim: true,
  isLength: { options: { max }, errorMessage: message },
});

export const requiredString = (min: number, max: number, message: string): Schema[string] => ({
  in: ['body'],
  isString: { errorMessage: message, bail: true },
  trim: true,
  isLength: { options: { min, max }, errorMessage: message },
});

// Accepts Nigerian numbers in any common format and international numbers with a country code
export const optionalPhone = (field = 'phone'): Schema[string] => ({
  in: ['body'],
  optional: { options: { values: 'falsy' } },
  isString: { errorMessage: 'Enter a valid phone number', bail: true },
  custom: {
    options: (value: string) => {
      if (!normalizePhone(value)) throw new Error(`Enter a valid ${field === 'phone' ? 'phone number' : field} (Nigerian, or international with a country code)`);
      return true;
    },
  },
  customSanitizer: { options: (value: string) => (value ? normalizePhone(value) : null) },
});

export const optionalEmail: Schema[string] = {
  in: ['body'],
  optional: { options: { values: 'falsy' } },
  trim: true,
  isEmail: { errorMessage: 'Enter a valid email address' },
  isLength: { options: { max: 255 }, errorMessage: 'Email is too long' },
  toLowerCase: true,
};

export const publicIdParam = (name: string, prefix: 'ord' | 'cus' | 'pat' | 'stl'): Schema[string] => ({
  in: ['params'],
  matches: { options: [new RegExp(`^${prefix}_[0-9A-Za-z]{20}$`)], errorMessage: 'Not found' },
});

export const linkIdParam: Schema[string] = {
  in: ['params'],
  matches: { options: [LINK_ID_PATTERN], errorMessage: 'Not found' },
};

export const paginationQuery: Schema = {
  page: { in: ['query'], optional: true, isInt: { options: { min: 1, max: 100000 }, errorMessage: 'Invalid page' } },
  limit: { in: ['query'], optional: true, isInt: { options: { min: 1, max: 100 }, errorMessage: 'Invalid limit' } },
};

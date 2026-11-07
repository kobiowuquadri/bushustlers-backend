import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { config } from '../config/config.js';
import { messageHandler } from '../utils/index.js';
import { TOO_MANY_REQUESTS } from '../constants/statusCode.js';

const tooMany = messageHandler('Too many requests, please try again later', false, TOO_MANY_REQUESTS, { code: 'rate_limited' });

const limiter = (options: Partial<Options>) =>
  rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: tooMany,
    // Tests exercise the same endpoints many times from one address
    skip: () => config.app.env === 'test',
    ...options,
  });

// Slows down brute-force and credential-stuffing attempts on auth routes (per client IP)
export const authLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20 });

// Per-account limit on sign-in attempts, so attempts spread across many IPs still hit a ceiling.
// Runs after body parsing/validation, keyed by the normalised email address.
export const loginAccountLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `login:${String(req.body?.email || '').toLowerCase()}`,
});

// Password reset and verification emails
export const emailLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 5 });

// Public checkout: creating payment instructions and asking for a status refresh
export const checkoutWriteLimiter = limiter({ windowMs: 10 * 60 * 1000, limit: 30 });
export const checkoutReadLimiter = limiter({ windowMs: 60 * 1000, limit: 120 });

// Merchant-triggered provider lookups
export const providerRefreshLimiter = limiter({ windowMs: 60 * 1000, limit: 20, keyGenerator: (req) => `refresh:${req.user?.id ?? ipKeyGenerator(req.ip || '')}` });

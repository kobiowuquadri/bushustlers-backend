import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/config.js';
import { FORBIDDEN } from '../constants/statusCode.js';
import { COOKIE_NAMES, setCsrfCookie } from '../utils/cookies.js';
import { generateRandomToken, messageHandler } from '../utils/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Issues the double-submit CSRF cookie when a browser does not have one yet.
export const ensureCsrfCookie = (req: Request, res: Response, next: NextFunction) => {
  if (!req.cookies?.[COOKIE_NAMES.csrf]) {
    const token = generateRandomToken(24);
    setCsrfCookie(res, token);
    req.cookies = { ...(req.cookies || {}), [COOKIE_NAMES.csrf]: token };
  }
  next();
};

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// Cookie-authenticated, state-changing requests must (1) come from an allowed origin when the browser
// sends an Origin header and (2) echo the CSRF cookie in X-CSRF-Token. SameSite=Lax cookies are a third layer.
export const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin && config.server.corsOrigins.length && !config.server.corsOrigins.includes(origin.replace(/\/+$/, ''))) {
    return res.status(FORBIDDEN).json(messageHandler('Request origin not allowed', false, FORBIDDEN, { code: 'origin_not_allowed' }));
  }

  const cookie = req.cookies?.[COOKIE_NAMES.csrf];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !sameToken(cookie, header)) {
    return res.status(FORBIDDEN).json(messageHandler('Security check failed. Refresh the page and try again.', false, FORBIDDEN, { code: 'csrf_failed' }));
  }
  next();
};

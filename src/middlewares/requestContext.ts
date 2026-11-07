import type { NextFunction, Request, Response } from 'express';
import { randomBase62 } from '../utils/ids.js';
import { logger } from '../utils/logger.js';

const INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Assigns a request id (reusing a well-formed incoming X-Request-Id) and logs one line per request.
// Only the path is logged, never query strings or bodies, so tokens and personal data stay out of logs.
export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && INCOMING_ID.test(incoming) ? incoming : `req_${randomBase62(16)}`;
  res.setHeader('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/health') return;
    const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    const meta = { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, durationMs };
    if (res.statusCode >= 500) logger.error('request', meta);
    else logger.info('request', meta);
  });
  next();
};

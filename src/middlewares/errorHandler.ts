import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { UniqueConstraintError } from 'sequelize';
import { AppError, messageHandler } from '../utils/index.js';
import { describeError, logger } from '../utils/logger.js';
import { ProviderError } from '../modules/payments/types.js';
import { BAD_REQUEST, CONFLICT, INTERNAL_SERVER_ERROR, NOT_FOUND, SERVICE_UNAVAILABLE, UPLOAD_LIMIT_EXCEEDED } from '../constants/statusCode.js';

// Client errors raised by Express itself, e.g. malformed JSON or an oversized body
const isExposedHttpError = (err: unknown): err is { status: number; message: string } => {
  return typeof err === 'object' && err !== null && 'status' in err && 'expose' in err && err.expose === true;
};

export const notFound = (req: Request, res: Response) => {
  res.status(NOT_FOUND).json(messageHandler(`Route ${req.method} ${req.path} not found`, false, NOT_FOUND, { code: 'route_not_found' }));
};

// Express only treats this as an error handler because it declares all four parameters
export const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json(messageHandler(err.message, false, err.statusCode, err.data));
  }

  // A provider failure that escaped a service: report it as a temporary outage, never with provider internals
  if (err instanceof ProviderError) {
    logger.warn('Unhandled provider error', { requestId: req.id, kind: err.kind, httpStatus: err.httpStatus });
    return res.status(SERVICE_UNAVAILABLE).json(messageHandler('The payment provider is temporarily unavailable. Please try again shortly.', false, SERVICE_UNAVAILABLE, { code: 'provider_unavailable', requestId: req.id }));
  }

  if (err instanceof multer.MulterError) {
    const statusCode = err.code === 'LIMIT_FILE_SIZE' ? UPLOAD_LIMIT_EXCEEDED : BAD_REQUEST;
    return res.status(statusCode).json(messageHandler(`Upload error: ${err.message}`, false, statusCode));
  }

  // e.g. two requests registering the same email at the same time
  if (err instanceof UniqueConstraintError) {
    return res.status(CONFLICT).json(messageHandler('Resource already exists', false, CONFLICT, { code: 'conflict' }));
  }

  if (isExposedHttpError(err)) {
    return res.status(err.status).json(messageHandler(err.message, false, err.status));
  }

  // Log the details, but never send them to the client
  logger.error('Unhandled error', { requestId: req.id, path: req.path, ...describeError(err) });
  res.status(INTERNAL_SERVER_ERROR).json(messageHandler('Something went wrong', false, INTERNAL_SERVER_ERROR, { code: 'internal_error', requestId: req.id }));
};

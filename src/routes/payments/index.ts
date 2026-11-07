import express from 'express';
import { validate } from '../../validations/index.js';
import { checkoutReadLimiter, checkoutWriteLimiter } from '../../middlewares/rateLimiter.js';
import { getCheckoutController, receiptController, refreshPaymentController, startPaymentController, webhookController } from '../../controllers/payments/publicPaymentsController.js';
import { attemptValidation, checkoutLinkValidation, startPaymentValidation } from '../../validations/checkoutValidations.js';

// Public checkout. No buyer account and no cookies are involved, so CSRF does not apply;
// every link and payment id in the URL is an unguessable public identifier.
export const checkoutRouter = express.Router();
checkoutRouter.get('/:linkId', checkoutReadLimiter, validate(checkoutLinkValidation), getCheckoutController);
checkoutRouter.post('/:linkId/payments', checkoutWriteLimiter, validate(startPaymentValidation), startPaymentController);
checkoutRouter.post('/:linkId/payments/:attemptId/refresh', checkoutWriteLimiter, validate(attemptValidation), refreshPaymentController);
checkoutRouter.get('/:linkId/receipt', checkoutReadLimiter, validate(checkoutLinkValidation), receiptController);

// Provider webhooks. Mounted with express.raw() before the JSON parser (see app.ts).
export const webhookRouter = express.Router();
webhookRouter.post('/busha', webhookController('busha'));
webhookRouter.post('/demo', webhookController('demo'));

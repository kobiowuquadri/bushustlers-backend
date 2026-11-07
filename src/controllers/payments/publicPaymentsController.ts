import type { Request, Response } from 'express';
import { asyncHandler, messageHandler, sendResponse } from '../../utils/index.js';
import { getCheckoutService, getReceiptService, refreshPaymentService, startPaymentService } from '../../services/payments/checkoutService.js';
import { ingestWebhook, processProviderEvent } from '../../services/payments/webhookService.js';
import { describeError, logger } from '../../utils/logger.js';
import { SUCCESS } from '../../constants/statusCode.js';
import type { PaymentProviderName } from '../../schemas/payments/paymentAttemptSchema.js';

// ---- Public checkout (no buyer account) ------------------------------------------------------
export const getCheckoutController = asyncHandler(async (req: Request<{ linkId: string }>, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendResponse(res, await getCheckoutService(req.params.linkId));
});

export const startPaymentController = asyncHandler(async (req: Request<{ linkId: string }>, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendResponse(res, await startPaymentService(req.params.linkId, req.body, String(req.get('idempotency-key')), req.id));
});

export const refreshPaymentController = asyncHandler(async (req: Request<{ linkId: string; attemptId: string }>, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendResponse(res, await refreshPaymentService(req.params.linkId, req.params.attemptId, req.id));
});

export const receiptController = asyncHandler(async (req: Request<{ linkId: string }>, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  sendResponse(res, await getReceiptService(req.params.linkId));
});

// ---- Provider webhooks -----------------------------------------------------------------------
// The body arrives as raw bytes (express.raw on this route) so the signature is checked against exactly
// what the provider signed. The event is stored before the 200 is sent, then processed in the background;
// the reconciler retries anything that fails.
export const webhookController = (provider: PaymentProviderName) =>
  asyncHandler(async (req: Request, res: Response) => {
    const { event, duplicate } = await ingestWebhook(provider, req.body as Buffer, req.get('x-bu-signature'), req.id);
    sendResponse(res, messageHandler(duplicate ? 'Already received' : 'Received', true, SUCCESS));
    if (!duplicate) {
      setImmediate(() => {
        processProviderEvent(event.id, req.id).catch((error) => logger.error('Webhook processing error', { eventId: event.id, ...describeError(error) }));
      });
    }
  });

import type { Request, Response } from 'express';
import { config } from '../config/config.js';
import { EmailOutbox } from '../schemas/index.js';
import { getPaymentProvider } from '../modules/payments/index.js';
import { asyncHandler, messageHandler, sendResponse } from '../utils/index.js';
import { NOT_FOUND, SUCCESS } from '../constants/statusCode.js';

// Public, non-secret configuration the website and checkout need: environment labels and proposed pricing.
// The marketing pricing section reads these values so displayed fees always match backend calculations.
export const publicConfigController = (req: Request, res: Response) => {
  const provider = getPaymentProvider();
  res.setHeader('Cache-Control', 'public, max-age=300');
  sendResponse(
    res,
    messageHandler('OK', true, SUCCESS, {
      appEnv: config.app.env,
      paymentsMode: provider.mode,
      supportEmail: config.app.supportEmail || null,
      pricing: {
        status: config.fees.status,
        paidBy: 'business',
        setupFeeMinor: '0',
        monthlyFeeMinor: '0',
        ngnBps: config.fees.ngnBps,
        ngnCapMinor: String(config.fees.ngnCapMinor),
        stablecoinBps: config.fees.stablecoinBps,
      },
      stablecoinOptions: provider.stablecoinOptions(),
    }),
  );
};

// Development only: emails captured instead of sent when no email provider is configured.
// The route is not even registered unless the dev mailbox is enabled (never in sandbox or production).
export const devMailboxController = asyncHandler(async (req: Request, res: Response) => {
  if (!config.email.devMailbox) {
    return res.status(NOT_FOUND).json(messageHandler('Not found', false, NOT_FOUND));
  }
  const emails = await EmailOutbox.findAll({ where: { status: 'captured' }, order: [['createdAt', 'DESC']], limit: 30 });
  sendResponse(
    res,
    messageHandler('Captured emails', true, SUCCESS, {
      items: emails.map((email) => ({ id: email.id, to: email.toEmail, subject: email.subject, template: email.template, html: email.html, createdAt: email.createdAt })),
    }),
  );
});

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import nodemailer, { type Transporter } from 'nodemailer';
import { Op } from 'sequelize';
import { config } from '../../config/config.js';
import { EmailOutbox } from '../../schemas/index.js';
import { describeError, logger } from '../../utils/logger.js';
import { sendBrevoEmail } from './brevo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The build script copies the templates into dist/, so this resolves from both src/ and dist/
const viewPath = path.resolve(__dirname, '..', 'views');

export type EmailTemplate = 'verify-email' | 'reset-password' | 'password-changed' | 'payment-confirmed' | 'payment-review';

const compiled = new Map<string, Handlebars.TemplateDelegate>();
let layout: Handlebars.TemplateDelegate | null = null;

const render = async (template: EmailTemplate, context: Record<string, unknown>) => {
  if (!layout) layout = Handlebars.compile(await fs.readFile(path.join(viewPath, 'layout.handlebars'), 'utf8'));
  let body = compiled.get(template);
  if (!body) {
    body = Handlebars.compile(await fs.readFile(path.join(viewPath, `${template}.handlebars`), 'utf8'));
    compiled.set(template, body);
  }
  const shared = { appName: config.app.name, currentYear: new Date().getFullYear(), frontendUrl: config.app.frontendUrl, ...context };
  return layout({ ...shared, body: new Handlebars.SafeString(body(shared)) });
};

let transporter: Transporter | undefined;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: config.email.user, pass: config.email.password },
    });
  }
  return transporter;
};

export const emailDeliveryMode = () => {
  if (config.brevo.apiKey && config.brevo.senderEmail) return 'brevo' as const;
  if (config.email.user && config.email.password) return 'smtp' as const;
  if (config.email.devMailbox) return 'dev_mailbox' as const;
  return 'disabled' as const;
};

export interface SendMailInput {
  to: string;
  subject: string;
  template: EmailTemplate;
  context: Record<string, unknown>;
}

// Queues an email and returns immediately; the email worker delivers it in the background with retries.
// Without any email provider in local development, the email is captured for /dev/mailbox instead.
// Email content (which may contain single-use links) is never logged.
export const sendMail = async ({ to, subject, template, context }: SendMailInput) => {
  const mode = emailDeliveryMode();
  try {
    const html = await render(template, { ...context, subject });
    if (mode === 'dev_mailbox') {
      await EmailOutbox.create({ toEmail: to, subject, template, status: 'captured', html });
      return true;
    }
    if (mode === 'disabled') {
      await EmailOutbox.create({ toEmail: to, subject, template, status: 'failed', error: 'No email provider configured' });
      logger.warn('Email not queued: no email provider configured', { template });
      return false;
    }
    await EmailOutbox.create({ toEmail: to, subject, template, status: 'queued', html, nextAttemptAt: new Date() });
    // Nudge the worker so emails like password resets go out within a second or two
    setImmediate(() => void processEmailQueue());
    return true;
  } catch (error) {
    logger.error('Could not queue email', { template, ...describeError(error) });
    return false;
  }
};

// ---- Worker -----------------------------------------------------------------------------------
const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800];
const BATCH = 10;
const STALE_SENDING_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

const deliver = async (email: EmailOutbox) => {
  const mode = emailDeliveryMode();
  if (mode === 'brevo') return sendBrevoEmail({ to: email.toEmail, subject: email.subject, html: email.html || '' });
  if (mode === 'smtp') {
    try {
      await getTransporter().sendMail({ from: { name: config.app.name, address: config.email.user }, to: email.toEmail, subject: email.subject, html: email.html || '' });
      return { ok: true } as const;
    } catch (error) {
      return { ok: false, retryable: true, error: `SMTP ${error instanceof Error ? error.message : 'error'}`.slice(0, 200) };
    }
  }
  return { ok: false, retryable: false, error: 'No email provider configured' };
};

// Sends queued emails. Each row is claimed with a conditional UPDATE, so several API instances sharing
// one database never send the same email twice.
export const processEmailQueue = async () => {
  if (running) return;
  running = true;
  try {
    // Recover rows left in "sending" by a process that stopped mid-send
    await EmailOutbox.update({ status: 'queued' }, { where: { status: 'sending', updatedAt: { [Op.lt]: new Date(Date.now() - STALE_SENDING_MS) } } });

    const due = await EmailOutbox.findAll({
      where: { status: 'queued', [Op.or]: [{ nextAttemptAt: null }, { nextAttemptAt: { [Op.lte]: new Date() } }] },
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    for (const email of due) {
      const [claimed] = await EmailOutbox.update({ status: 'sending' }, { where: { id: email.id, status: 'queued' } });
      if (!claimed) continue;
      const attempts = email.attempts + 1;
      const result = await deliver(email);
      if (result.ok) {
        await EmailOutbox.update({ status: 'sent', sentAt: new Date(), attempts, error: null, html: null }, { where: { id: email.id } });
        continue;
      }
      const giveUp = !result.retryable || attempts >= MAX_ATTEMPTS;
      await EmailOutbox.update(
        giveUp
          ? { status: 'failed', attempts, error: result.error ?? 'Delivery failed', html: null }
          : { status: 'queued', attempts, error: result.error ?? 'Delivery failed', nextAttemptAt: new Date(Date.now() + BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] * 1000) },
        { where: { id: email.id } },
      );
      logger.warn(giveUp ? 'Email delivery failed permanently' : 'Email delivery failed; will retry', { emailId: email.id, template: email.template, attempts, reason: result.error });
    }
  } catch (error) {
    logger.error('Email worker cycle failed', describeError(error));
  } finally {
    running = false;
  }
};

export const startEmailWorker = () => {
  const mode = emailDeliveryMode();
  if (timer || (mode !== 'brevo' && mode !== 'smtp') || config.app.env === 'test') return;
  timer = setInterval(() => void processEmailQueue(), 5_000);
  timer.unref();
  void processEmailQueue();
  logger.info('Email worker started', { provider: mode });
};

export const stopEmailWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import nodemailer, { type Transporter } from 'nodemailer';
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

// Sends through Brevo or Gmail SMTP when configured. Without credentials in local development the email is
// captured in the database and shown at /dev/mailbox instead. Email content (which may contain links with
// tokens) is never logged.
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
      logger.warn('Email not sent: no email provider configured', { template });
      return false;
    }
    let sent = false;
    if (mode === 'brevo') {
      sent = await sendBrevoEmail({ to, subject, html });
    } else {
      await getTransporter().sendMail({ from: { name: config.app.name, address: config.email.user }, to, subject, html });
      sent = true;
    }
    await EmailOutbox.create({ toEmail: to, subject, template, status: sent ? 'sent' : 'failed', error: sent ? null : 'Provider rejected the email' });
    return sent;
  } catch (error) {
    logger.error('Email delivery failed', { template, ...describeError(error) });
    await EmailOutbox.create({ toEmail: to, subject, template, status: 'failed', error: 'Delivery error' }).catch(() => undefined);
    return false;
  }
};

import axios from 'axios';
import { config } from '../../config/config.js';

export interface BrevoEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ content: string; name: string }>;
}

export interface BrevoResult {
  ok: boolean;
  // Safe to store/log: status and Brevo's error code only, never request headers (which hold the API key)
  error?: string;
  retryable?: boolean;
}

export async function sendBrevoEmail(options: BrevoEmailOptions): Promise<BrevoResult> {
  try {
    const payload = {
      sender: { email: config.brevo.senderEmail, name: config.brevo.senderName },
      to: [{ email: options.to }],
      subject: options.subject,
      htmlContent: options.html,
      textContent: options.text,
      attachment: options.attachments,
    };
    await axios.post(config.brevo.apiUrl, payload, {
      headers: {
        'api-key': config.brevo.apiKey,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      timeout: 10000,
    });
    return { ok: true };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const code = (error.response?.data as { code?: string } | undefined)?.code;
      // Network errors, 5xx and 429 are transient. 401/403 are retried too: Brevo uses them for account settings
      // that get fixed later (e.g. an IP not yet on the "Authorised IPs" list). Other 4xx (bad recipient) won't recover.
      const retryable = !status || status >= 500 || status === 429 || status === 401 || status === 403;
      return { ok: false, retryable, error: `Brevo ${status ?? 'network error'}${code ? ` ${code}` : ''}`.slice(0, 200) };
    }
    return { ok: false, retryable: true, error: 'Brevo request failed' };
  }
}

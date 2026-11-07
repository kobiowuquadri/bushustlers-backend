import axios from 'axios';
import { config } from '../../config/config.js';

export interface BrevoEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ content: string; name: string }>;
}

export async function sendBrevoEmail(options: BrevoEmailOptions): Promise<boolean> {
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
    return true;
  } catch (error) {
    // Don't log the whole axios error: it contains the request headers, including the API key
    const detail = axios.isAxiosError(error) ? error.response?.data ?? error.message : error;
    console.error('Brevo email error:', detail);
    return false;
  }
}

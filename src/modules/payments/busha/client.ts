import axios, { type AxiosInstance, type Method } from 'axios';
import { ProviderError } from '../types.js';

// Thin HTTP client for the documented Busha endpoints used by Bushustlers:
//   POST /v1/quotes, POST /v1/transfers, GET /v1/transfers/{id}           (Authorization: Bearer <secret key>)
//   POST /v1/payments/requests, GET /v1/payments/requests/{id}             (X-BU-PUBLIC-KEY: <public key>)
//   POST /v1/transfers/simulate-deposit                                    (sandbox testing)
// Responses use the envelope { status, message, data }; errors use { error: { name, message } }.

export interface BushaFee {
  name?: string;
  type?: string;
  amount?: { amount?: string; currency?: string };
}

export interface BushaPayIn {
  type?: string;
  address?: string;
  network?: string;
  memo?: string;
  expires_at?: string;
  recipient_details?: { account_name?: string; account_number?: string; bank_name?: string };
}

export interface BushaQuote {
  id: string;
  source_currency: string;
  target_currency: string;
  source_amount: string;
  target_amount: string;
  status?: string;
  expires_at?: string;
}

export interface BushaTransfer {
  id: string;
  quote_id?: string;
  source_currency: string;
  target_currency: string;
  source_amount: string;
  target_amount: string;
  status: string;
  fees?: BushaFee[];
  pay_in?: BushaPayIn;
  reference?: string;
  updated_at?: string;
}

export interface BushaPaymentRequest {
  id: string;
  status: string;
  reference?: string;
  source_amount: string;
  source_currency: string;
  target_amount: string;
  target_currency: string;
  requested_amount?: string;
  currency?: string;
  rate?: { rate?: string; rate_explained?: string };
  fees?: BushaFee[];
  pay_in?: BushaPayIn;
  expires_at?: string;
  updated_at?: string;
}

interface Envelope<T> {
  status?: string;
  message?: string;
  data?: T;
}

export interface BushaClientOptions {
  baseUrl: string;
  secretKey: string;
  publicKey: string;
  timeoutMs: number;
}

const toProviderError = (error: unknown): ProviderError => {
  if (error instanceof ProviderError) return error;
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return new ProviderError('unavailable', error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'Payment provider timed out' : 'Payment provider could not be reached');
    }
    const status = error.response.status;
    const body = error.response.data as { error?: { name?: string; message?: string } } | undefined;
    const name = typeof body?.error?.name === 'string' ? body.error.name.slice(0, 60) : null;
    const message = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 200) : `Provider responded with HTTP ${status}`;
    if (status === 401 || status === 403) return new ProviderError('misconfigured', 'Payment provider rejected the configured credentials', status, name);
    if (status === 404) return new ProviderError('not_found', message, status, name);
    if (status === 429 || status >= 500) return new ProviderError('unavailable', 'Payment provider is temporarily unavailable', status, name);
    return new ProviderError('rejected', message, status, name);
  }
  return new ProviderError('unavailable', 'Unexpected error talking to the payment provider');
};

export class BushaClient {
  private readonly http: AxiosInstance;

  constructor(private readonly options: BushaClientOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Never follow redirects with credentials attached
      maxRedirects: 0,
    });
  }

  private async call<T>(method: Method, path: string, auth: 'secret' | 'public', body?: unknown): Promise<T> {
    const headers = auth === 'secret' ? { Authorization: `Bearer ${this.options.secretKey}` } : { 'X-BU-PUBLIC-KEY': this.options.publicKey };
    try {
      const response = await this.http.request<Envelope<T>>({ method, url: path, data: body, headers });
      const envelope = response.data;
      if (!envelope || envelope.status !== 'success') {
        throw new ProviderError('rejected', envelope?.message?.slice(0, 200) || 'Unexpected provider response', response.status);
      }
      return envelope.data as T;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  createQuote(body: Record<string, unknown>) {
    return this.call<BushaQuote>('POST', '/v1/quotes', 'secret', body);
  }

  createTransfer(quoteId: string) {
    return this.call<BushaTransfer>('POST', '/v1/transfers', 'secret', { quote_id: quoteId });
  }

  getTransfer(id: string) {
    return this.call<BushaTransfer>('GET', `/v1/transfers/${encodeURIComponent(id)}`, 'secret');
  }

  createPaymentRequest(body: Record<string, unknown>) {
    return this.call<BushaPaymentRequest>('POST', '/v1/payments/requests', 'public', body);
  }

  getPaymentRequest(id: string) {
    return this.call<BushaPaymentRequest>('GET', `/v1/payments/requests/${encodeURIComponent(id)}`, 'public');
  }

  // Sandbox only: marks a pending deposit transfer as completed or failed, which triggers Busha's webhooks.
  simulateDeposit(transferId: string, status: 'completed' | 'failed') {
    return this.call<unknown>('POST', '/v1/transfers/simulate-deposit', 'secret', { transfer_id: transferId, status });
  }
}

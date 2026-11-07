import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import app from '../src/app.js';
import { computeSignature } from '../src/modules/payments/signature.js';

export const ORIGIN = 'http://localhost:3000';
let counter = 0;

export type Agent = ReturnType<typeof request.agent>;

const cookieValue = (setCookie: string[] | string | undefined, suffix: string) => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of list) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (pair.slice(0, index).endsWith(suffix)) return pair.slice(index + 1);
  }
  return null;
};

// A browser-like client: keeps cookies and sends the CSRF header on every request.
export const browser = async () => {
  const agent = request.agent(app);
  const res = await agent.get('/api/v1/auth/csrf').set('Origin', ORIGIN);
  const csrf = cookieValue(res.headers['set-cookie'], 'bh_csrf');
  if (!csrf) throw new Error('No CSRF cookie issued');
  const send = (method: 'get' | 'post' | 'put' | 'patch', path: string, body?: unknown) => {
    const req = agent[method](path).set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
    return body === undefined ? req : req.send(body as object);
  };
  return { agent, csrf, send };
};

export const uniqueEmail = (label: string) => `${label}.${Date.now()}.${++counter}@example.com`;

// Signs up, sets up a business and returns a ready merchant client.
export const createMerchant = async (businessName = 'Amaka Clothing') => {
  const client = await browser();
  const email = uniqueEmail('merchant');
  const register = await client.send('post', '/api/v1/auth/register', { fullName: 'Amaka Obi', email, password: 'Linen-set-104!' });
  if (register.status !== 201) throw new Error(`register failed: ${register.status} ${JSON.stringify(register.body)}`);
  const business = await client.send('post', '/api/v1/business', { businessName, category: 'fashion', settlementPreference: 'naira' });
  if (business.status !== 201) throw new Error(`business failed: ${business.status} ${JSON.stringify(business.body)}`);
  return { ...client, email };
};

export const createOrderWithLink = async (merchant: Awaited<ReturnType<typeof createMerchant>>, unitPriceMinor = '4500000', customer: Record<string, unknown> = { name: 'Tolu Adeyemi', email: 'tolu@example.com' }) => {
  const order = await merchant.send('post', '/api/v1/orders', { customer, items: [{ name: 'Linen two-piece set', quantity: 1, unitPriceMinor }] });
  if (order.status !== 201) throw new Error(`order failed: ${order.status} ${JSON.stringify(order.body)}`);
  const link = await merchant.send('post', `/api/v1/orders/${order.body.data.order.id}/links`, { expiresInHours: 72 });
  if (link.status !== 201) throw new Error(`link failed: ${link.status} ${JSON.stringify(link.body)}`);
  return { orderId: order.body.data.order.id as string, reference: order.body.data.order.reference as string, linkId: link.body.data.link.id as string };
};

export const idempotencyKey = () => `test-key-${Date.now()}-${++counter}-abcdefgh`;

export const startPayment = (linkId: string, body: Record<string, unknown>, key = idempotencyKey()) =>
  request(app).post(`/api/v1/checkout/${linkId}/payments`).set('Idempotency-Key', key).send(body);

export const postWebhook = (provider: 'busha' | 'demo', payload: unknown, secret: string, options: { signature?: string; raw?: string } = {}) => {
  const raw = options.raw ?? JSON.stringify(payload);
  const signature = options.signature ?? computeSignature(Buffer.from(raw), secret);
  return request(app).post(`/api/v1/webhooks/${provider}`).set('Content-Type', 'application/json').set('x-bu-signature', signature).send(raw);
};

export const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5_000): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

// ---- A fake Busha API that records calls and lets each test script the responses -------------
export interface FakeTransfer {
  id: string;
  status: string;
  source_amount: string;
  source_currency: string;
  target_amount: string;
  target_currency: string;
  reference?: string;
}
export interface FakePaymentRequest {
  id: string;
  status: string;
  reference: string;
  source_amount: string;
  source_currency: string;
  target_amount: string;
  target_currency: string;
  requested_amount: string;
  currency: string;
}

export const startFakeBusha = async () => {
  const state = {
    calls: [] as Array<{ method: string; path: string; auth?: string; publicKey?: string; body: unknown }>,
    transfers: new Map<string, FakeTransfer>(),
    requests: new Map<string, FakePaymentRequest>(),
    quotes: new Map<string, { source_amount: string; reference: string }>(),
    delayMs: 0,
    failNext: null as null | number,
    seq: 0,
  };
  const fake = express();
  fake.use(express.json());
  fake.use(async (req, res, next) => {
    state.calls.push({ method: req.method, path: req.path, auth: req.get('authorization') || undefined, publicKey: req.get('x-bu-public-key') || undefined, body: req.body });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.failNext) {
      const status = state.failNext;
      state.failNext = null;
      return res.status(status).json({ error: { name: 'internal_server_error', message: 'Internal Server Error' } });
    }
    next();
  });
  fake.post('/v1/quotes', (req, res) => {
    const id = `QUO_test${++state.seq}`;
    state.quotes.set(id, { source_amount: req.body.source_amount, reference: req.body.reference });
    res.status(201).json({ status: 'success', message: 'Created quote successfully', data: { id, source_currency: 'NGN', target_currency: 'NGN', source_amount: req.body.source_amount, target_amount: req.body.source_amount, status: 'pending' } });
  });
  fake.post('/v1/transfers', (req, res) => {
    const quote = state.quotes.get(req.body.quote_id);
    if (!quote) return res.status(404).json({ error: { name: 'resource_not_found', message: 'Resource Not Found' } });
    const id = `TRF_test${++state.seq}`;
    const transfer: FakeTransfer = { id, status: 'pending', source_amount: quote.source_amount, source_currency: 'NGN', target_amount: quote.source_amount, target_currency: 'NGN', reference: quote.reference };
    state.transfers.set(id, transfer);
    res.status(201).json({
      status: 'success',
      message: 'Created transfer successfully',
      data: { ...transfer, fees: [], pay_in: { type: 'temporary_bank_account', expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), recipient_details: { account_name: 'Sandbox Test Account', account_number: `70${String(state.seq).padStart(8, '0')}`, bank_name: 'Sandbox Bank' } } },
    });
  });
  fake.get('/v1/transfers/:id', (req, res) => {
    const transfer = state.transfers.get(req.params.id);
    if (!transfer) return res.status(404).json({ error: { name: 'resource_not_found', message: 'Resource Not Found' } });
    res.json({ status: 'success', message: 'ok', data: { ...transfer, fees: [{ name: 'payment gateway fee', type: 'FIXED', amount: { amount: '100', currency: 'NGN' } }] } });
  });
  fake.post('/v1/transfers/simulate-deposit', (req, res) => {
    const transfer = state.transfers.get(req.body.transfer_id);
    if (!transfer) return res.status(404).json({ error: { name: 'resource_not_found', message: 'Resource Not Found' } });
    transfer.status = req.body.status === 'completed' ? 'funds_received' : 'failed';
    res.json({ status: 'success', message: 'Simulated' });
  });
  fake.post('/v1/payments/requests', (req, res) => {
    const id = `PAYR_test${++state.seq}`;
    const request: FakePaymentRequest = { id, status: 'pending', reference: req.body.reference, source_amount: '30.012345', source_currency: req.body.source_currency, target_amount: req.body.quote_amount, target_currency: req.body.target_currency, requested_amount: req.body.quote_amount, currency: req.body.quote_currency };
    state.requests.set(id, request);
    res.status(201).json({ status: 'success', message: 'Payment request created', data: { ...request, fees: [], rate: { rate: '1499.38', rate_explained: '1 USDT = 1499.38 NGN' }, expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), pay_in: { type: 'address', network: req.body.pay_in.network, address: 'TTestAddressForSandboxOnly0000001', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() } } });
  });
  fake.get('/v1/payments/requests/:id', (req, res) => {
    const request = state.requests.get(req.params.id);
    if (!request) return res.status(404).json({ error: { name: 'resource_not_found', message: 'Resource Not Found' } });
    res.json({ status: 'success', message: 'ok', data: { ...request, fees: [] } });
  });

  const server: Server = await new Promise((resolve) => {
    const s = fake.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { state, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

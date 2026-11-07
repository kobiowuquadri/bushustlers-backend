import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import sequelize from '../src/database/db.js';
import { PaymentAttempt, ProviderEvent, Settlement } from '../src/schemas/index.js';
import { BushaClient } from '../src/modules/payments/busha/client.js';
import { BushaProvider } from '../src/modules/payments/busha/provider.js';
import { setPaymentProviderForTests } from '../src/modules/payments/index.js';
import { parseStablecoinOptions } from '../src/constants/payments.js';
import { processProviderEvent } from '../src/services/payments/webhookService.js';
import { createMerchant, createOrderWithLink, idempotencyKey, postWebhook, startFakeBusha, startPayment, waitFor } from './helpers.js';

const WEBHOOK_SECRET = 'whsec_test_only';
let fake: Awaited<ReturnType<typeof startFakeBusha>>;

const useProvider = (timeoutMs = 2_000) =>
  setPaymentProviderForTests(
    new BushaProvider(new BushaClient({ baseUrl: fake.baseUrl, secretKey: 'sk_test_secret', publicKey: 'pub_test_public', timeoutMs }), {
      mode: 'sandbox',
      webhookSecret: WEBHOOK_SECRET,
      stablecoinOptions: parseStablecoinOptions('USDT:TRX').options,
    }),
  );

beforeAll(async () => {
  fake = await startFakeBusha();
});
beforeEach(() => {
  fake.state.delayMs = 0;
  fake.state.failNext = null;
  useProvider();
});
afterAll(async () => {
  setPaymentProviderForTests(null);
  await fake.close();
  await sequelize.close();
});

const transferEvent = (id: string, event = 'transfer.funds_received', extra: Record<string, unknown> = {}) => ({
  business_id: 'BUS_test',
  event,
  data: { id, status: event.split('.')[1], source_currency: 'NGN', target_currency: 'NGN', source_amount: '45000', target_amount: '44900', ...extra },
});

const processed = (attemptPublicId: string) =>
  waitFor(async () => {
    const attempt = await PaymentAttempt.findOne({ where: { publicId: attemptPublicId } });
    const pending = await ProviderEvent.count({ where: { paymentAttemptId: null, status: 'received' } });
    return attempt && pending === 0 ? attempt : null;
  });

describe('Busha adapter (sandbox, fake HTTP server)', () => {
  it('creates an NGN bank-transfer collection with the documented quote → transfer calls and headers', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    fake.state.calls.length = 0;
    const res = await startPayment(linkId, { route: 'bank_transfer' });
    expect(res.status).toBe(201);
    const [quoteCall, transferCall] = fake.state.calls;
    expect(quoteCall).toMatchObject({ method: 'POST', path: '/v1/quotes', auth: 'Bearer sk_test_secret' });
    expect(quoteCall.body).toMatchObject({ source_currency: 'NGN', target_currency: 'NGN', source_amount: '45000', pay_in: { type: 'temporary_bank_account' } });
    expect(String((quoteCall.body as { reference: string }).reference)).toMatch(/^BH-AMK\d+-/);
    expect(transferCall).toMatchObject({ method: 'POST', path: '/v1/transfers' });
    const instructions = res.body.data.payment.instructions;
    expect(instructions).toMatchObject({ kind: 'bank_transfer', bankName: 'Sandbox Bank', amount: '45000', demo: false });
    expect(res.body.data.checkout.mode).toBe('sandbox');
  });

  it('confirms a payment from a signed webhook only after an authenticated lookup, and dedupes retries', async () => {
    const merchant = await createMerchant();
    const { orderId, linkId } = await createOrderWithLink(merchant);
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    const attempt = (await PaymentAttempt.findOne({ where: { publicId: pay.body.data.payment.id } }))!;
    const transfer = fake.state.transfers.get(attempt.providerReference!)!;

    // The event claims success, but the provider still says pending: nothing changes
    const early = transferEvent(transfer.id);
    expect((await postWebhook('busha', early, WEBHOOK_SECRET)).status).toBe(200);
    await waitFor(async () => (await ProviderEvent.findOne({ where: { objectId: transfer.id, status: 'processed' } })) || null);
    expect((await PaymentAttempt.findByPk(attempt.id))!.status).toBe('awaiting_payment');

    // Provider now reports the deposit; the same notification body is retried twice
    transfer.status = 'funds_received';
    transfer.target_amount = '44900';
    const payload = transferEvent(transfer.id, 'transfer.funds_received', { updated_at: '2026-11-07T10:00:00Z' });
    const first = await postWebhook('busha', payload, WEBHOOK_SECRET);
    const retry = await postWebhook('busha', payload, WEBHOOK_SECRET);
    expect(first.body.message).toBe('Received');
    expect(retry.body.message).toBe('Already received');
    const confirmed = await waitFor(async () => {
      const a = await PaymentAttempt.findByPk(attempt.id);
      return a?.status === 'confirmed' ? a : null;
    });
    expect(confirmed.providerStatus).toBe('funds_received');
    expect(await Settlement.count({ where: { paymentAttemptId: attempt.id } })).toBe(1);
    const settlement = (await Settlement.findOne({ where: { paymentAttemptId: attempt.id } }))!;
    expect(settlement.grossMinor).toBe('4500000');
    expect(settlement.providerFeeMinor).toBe('10000'); // ₦100 gateway fee reported by the provider
    expect(settlement.platformFeeMinor).toBe('45000'); // 1% of ₦45,000
    expect(settlement.netMinor).toBe('4445000');

    // An out-of-order "pending" notification arrives late: the confirmed payment is not downgraded
    transfer.status = 'pending';
    await postWebhook('busha', transferEvent(transfer.id, 'transfer.pending'), WEBHOOK_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await PaymentAttempt.findByPk(attempt.id))!.status).toBe('confirmed');
    const order = await merchant.send('get', `/api/v1/orders/${orderId}`);
    expect(order.body.data.order.paymentStatus).toBe('paid');
  });

  it('rejects forged or unsigned notifications before storing anything', async () => {
    const before = await ProviderEvent.count();
    const payload = transferEvent('TRF_forged');
    expect((await postWebhook('busha', payload, 'attacker-secret')).status).toBe(401);
    expect((await request(app).post('/api/v1/webhooks/busha').set('Content-Type', 'application/json').send(JSON.stringify(payload))).status).toBe(401);
    // A valid signature over different bytes than the ones delivered fails too
    const raw = JSON.stringify(payload);
    const { computeSignature } = await import('../src/modules/payments/signature.js');
    expect((await postWebhook('busha', payload, WEBHOOK_SECRET, { raw: `${raw} `, signature: computeSignature(Buffer.from(raw), WEBHOOK_SECRET) })).status).toBe(401);
    expect(await ProviderEvent.count()).toBe(before);
  });

  it('holds wrong amounts and currencies for review instead of confirming', async () => {
    const merchant = await createMerchant();
    const a = await createOrderWithLink(merchant);
    const b = await createOrderWithLink(merchant);
    const payA = await startPayment(a.linkId, { route: 'bank_transfer' });
    const payB = await startPayment(b.linkId, { route: 'bank_transfer' });
    const attemptA = (await PaymentAttempt.findOne({ where: { publicId: payA.body.data.payment.id } }))!;
    const attemptB = (await PaymentAttempt.findOne({ where: { publicId: payB.body.data.payment.id } }))!;
    Object.assign(fake.state.transfers.get(attemptA.providerReference!)!, { status: 'funds_received', source_amount: '40000' });
    Object.assign(fake.state.transfers.get(attemptB.providerReference!)!, { status: 'funds_received', source_currency: 'USD' });

    const refreshA = await merchant.send('post', `/api/v1/transactions/${attemptA.publicId}/refresh`);
    const refreshB = await merchant.send('post', `/api/v1/transactions/${attemptB.publicId}/refresh`);
    expect(refreshA.body.data.transaction).toMatchObject({ status: 'needs_review', reviewReason: 'underpayment' });
    expect(refreshB.body.data.transaction).toMatchObject({ status: 'needs_review', reviewReason: 'currency_mismatch' });
    expect((await merchant.send('get', `/api/v1/orders/${a.orderId}`)).body.data.order.paymentStatus).toBe('needs_review');
  });

  it('reports provider timeouts as temporary unavailability without creating duplicate collections', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    useProvider(300);
    fake.state.delayMs = 800;
    const res = await startPayment(linkId, { route: 'bank_transfer' });
    expect(res.status).toBe(503);
    expect(res.body.data.code).toBe('provider_unavailable');
    const failed = await PaymentAttempt.findOne({ where: { status: 'failed' }, order: [['id', 'DESC']] });
    expect(failed?.failureReason).toMatch(/unavailable/);

    fake.state.delayMs = 0;
    useProvider();
    const retry = await startPayment(linkId, { route: 'bank_transfer' });
    expect(retry.status).toBe(201);

    // Provider outage during a status check is reported, and the payment is left untouched
    fake.state.failNext = 503;
    const check = await request(app).post(`/api/v1/checkout/${linkId}/payments/${retry.body.data.payment.id}/refresh`);
    expect(check.status).toBe(503);
    expect((await PaymentAttempt.findOne({ where: { publicId: retry.body.data.payment.id } }))!.status).toBe('awaiting_payment');
  });

  it('does not call the provider again for repeated initiation', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const key = idempotencyKey();
    fake.state.calls.length = 0;
    await startPayment(linkId, { route: 'bank_transfer' }, key);
    await startPayment(linkId, { route: 'bank_transfer' }, key);
    await startPayment(linkId, { route: 'bank_transfer' });
    expect(fake.state.calls.filter((c) => c.path === '/v1/quotes')).toHaveLength(1);
  });

  it('creates a stablecoin payment request with the public key and exact provider quote', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    fake.state.calls.length = 0;
    const res = await startPayment(linkId, { route: 'stablecoin', asset: 'USDT', network: 'TRX', email: 'buyer@example.com', name: 'Ngozi Okafor' });
    expect(res.status).toBe(201);
    const call = fake.state.calls[0];
    expect(call).toMatchObject({ method: 'POST', path: '/v1/payments/requests', publicKey: 'pub_test_public' });
    expect(call.auth).toBeUndefined();
    expect(call.body).toMatchObject({ quote_amount: '45000', quote_currency: 'NGN', source_currency: 'USDT', target_currency: 'NGN', pay_in: { type: 'address', network: 'TRX' }, additional_info: { email: 'buyer@example.com', name: 'Ngozi Okafor' } });
    expect(res.body.data.payment.instructions).toMatchObject({ asset: 'USDT', network: 'TRX', amount: '30.012345', rateSource: 'provider_quote', demo: false });

    // Busha's own under_payment status is respected
    const attempt = (await PaymentAttempt.findOne({ where: { publicId: res.body.data.payment.id } }))!;
    fake.state.requests.get(attempt.providerReference!)!.status = 'under_payment';
    const event = { business_id: 'BUS_test', event: 'payment_request.processing', data: { id: attempt.providerReference } };
    const delivered = await postWebhook('busha', event, WEBHOOK_SECRET);
    expect(delivered.status).toBe(200);
    const stored = (await ProviderEvent.findOne({ where: { objectId: attempt.providerReference }, order: [['id', 'DESC']] }))!;
    await processProviderEvent(stored.id);
    expect((await PaymentAttempt.findByPk(attempt.id))!.reviewReason).toBe('underpayment');
    await processed(attempt.publicId);
  });

  it('uses the documented sandbox simulate-deposit endpoint from merchant tools', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    fake.state.calls.length = 0;
    const sim = await merchant.send('post', `/api/v1/transactions/${pay.body.data.payment.id}/simulate`, { outcome: 'paid' });
    expect(sim.status).toBe(200);
    expect(fake.state.calls[0]).toMatchObject({ method: 'POST', path: '/v1/transfers/simulate-deposit', body: { status: 'completed' } });
    expect(sim.body.data.transaction.status).toBe('confirmed');
    expect((await merchant.send('post', `/api/v1/transactions/${pay.body.data.payment.id}/simulate`, { outcome: 'underpaid' })).status).toBe(409);
  });
});

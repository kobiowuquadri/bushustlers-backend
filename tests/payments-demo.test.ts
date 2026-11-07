import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import sequelize from '../src/database/db.js';
import { PaymentAttempt, ProviderEvent, Settlement } from '../src/schemas/index.js';
import { demoWebhookSecret } from '../src/modules/payments/index.js';
import { runReconciliationCycle } from '../src/services/payments/reconcilerJob.js';
import { createMerchant, createOrderWithLink, idempotencyKey, postWebhook, startPayment, waitFor } from './helpers.js';

afterAll(async () => {
  await sequelize.close();
});

describe('checkout with the explicit demo provider', () => {
  it('labels demo instructions so they can never be mistaken for real payment details', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const res = await startPayment(linkId, { route: 'bank_transfer' });
    expect(res.status).toBe(201);
    const { instructions } = res.body.data.payment;
    expect(instructions.demo).toBe(true);
    expect(instructions.accountNumber).toMatch(/^DEMO-/);
    expect(instructions.bankName).toMatch(/not a real bank/i);
    expect(res.body.data.checkout.mode).toBe('demo');

    const stable = await startPayment(linkId, { route: 'stablecoin', asset: 'USDT', network: 'TRX', email: 'buyer@example.com' });
    expect(stable.status).toBe(201);
    expect(stable.body.data.payment.instructions.address).toMatch(/^demo-/);
    expect(stable.body.data.payment.instructions.rateSource).toBe('demo');
    expect(stable.body.data.payment.instructions.amount).toBe('30.000000');
  });

  it('requires an email for stablecoin payments and rejects undocumented networks', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant, '4500000', { name: 'No Email Buyer' });
    expect((await startPayment(linkId, { route: 'stablecoin', asset: 'USDT', network: 'TRX' })).status).toBe(422);
    expect((await startPayment(linkId, { route: 'stablecoin', asset: 'USDT', network: 'DOGE', email: 'b@example.com' })).status).toBe(409);
  });

  it('makes payment initiation idempotent and reuses valid instructions', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const key = idempotencyKey();
    const [a, b] = await Promise.all([startPayment(linkId, { route: 'bank_transfer' }, key), startPayment(linkId, { route: 'bank_transfer' }, key)]);
    expect(a.body.data.payment.id).toBe(b.body.data.payment.id);
    const c = await startPayment(linkId, { route: 'bank_transfer' });
    expect(c.body.data.payment.id).toBe(a.body.data.payment.id);
    expect(await PaymentAttempt.count({ where: { publicId: a.body.data.payment.id } })).toBe(1);
  });

  it('buyer "check status" never marks an order paid by itself', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    const refresh = await request(app).post(`/api/v1/checkout/${linkId}/payments/${pay.body.data.payment.id}/refresh`);
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.payment.status).toBe('awaiting_payment');
    expect(refresh.body.data.checkout.order.paymentStatus).toBe('unpaid');
  });

  it('holds an underpayment for review, then lets the merchant accept it explicitly', async () => {
    const merchant = await createMerchant();
    const { orderId, linkId } = await createOrderWithLink(merchant);
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    const paymentId = pay.body.data.payment.id;

    const sim = await merchant.send('post', `/api/v1/transactions/${paymentId}/simulate`, { outcome: 'underpaid' });
    expect(sim.status).toBe(200);
    expect(sim.body.data.transaction.status).toBe('needs_review');
    expect(sim.body.data.transaction.reviewReason).toBe('underpayment');
    expect(sim.body.data.transaction.receivedAmountMinor).toBe('4000000');

    let order = await merchant.send('get', `/api/v1/orders/${orderId}`);
    expect(order.body.data.order.paymentStatus).toBe('needs_review');
    expect((await merchant.send('post', `/api/v1/orders/${orderId}/fulfilment`, { status: 'dispatched' })).status).toBe(409);

    const accept = await merchant.send('post', `/api/v1/transactions/${paymentId}/resolve`, { decision: 'accept', note: 'Agreed ₦5,000 discount with Tolu' });
    expect(accept.status).toBe(200);
    expect(accept.body.data.transaction.status).toBe('confirmed');
    expect(accept.body.data.transaction.settlement.grossMinor).toBe('4000000');
    expect(accept.body.data.transaction.settlement.platformFeeMinor).toBe('40000');
    order = await merchant.send('get', `/api/v1/orders/${orderId}`);
    expect(order.body.data.order.paymentStatus).toBe('paid');
    expect(order.body.data.order.amountPaidMinor).toBe('4000000');
  });

  it('records a second genuine payment for the same order and flags it instead of crediting twice', async () => {
    const merchant = await createMerchant();
    const { orderId, linkId } = await createOrderWithLink(merchant);
    const bank = await startPayment(linkId, { route: 'bank_transfer' });
    const stable = await startPayment(linkId, { route: 'stablecoin', asset: 'USDC', network: 'BASE', email: 'buyer@example.com' });
    await merchant.send('post', `/api/v1/transactions/${bank.body.data.payment.id}/simulate`, { outcome: 'paid' });
    const second = await merchant.send('post', `/api/v1/transactions/${stable.body.data.payment.id}/simulate`, { outcome: 'paid' });
    expect(second.body.data.transaction.status).toBe('needs_review');
    expect(second.body.data.transaction.reviewReason).toBe('duplicate_payment');

    const order = await merchant.send('get', `/api/v1/orders/${orderId}`);
    expect(order.body.data.order.paymentStatus).toBe('paid');
    expect(order.body.data.order.reviewRequired).toBe(true);
    expect(order.body.data.order.amountPaidMinor).toBe('4500000');
    const attemptIds = (await PaymentAttempt.findAll({ where: { publicId: [bank.body.data.payment.id, stable.body.data.payment.id] } })).map((a) => a.id);
    expect(await Settlement.count({ where: { paymentAttemptId: attemptIds } })).toBe(1);
  });

  it('keeps late funds in reconciliation after the instructions expired', async () => {
    const merchant = await createMerchant();
    const { linkId } = await createOrderWithLink(merchant);
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    const paymentId = pay.body.data.payment.id;
    // Instructions lapse and the reconciler closes them locally
    await PaymentAttempt.update({ expiresAt: new Date(Date.now() - 5 * 60_000) }, { where: { publicId: paymentId } });
    await runReconciliationCycle();
    expect((await PaymentAttempt.findOne({ where: { publicId: paymentId } }))!.status).toBe('expired');
    // Money arrives anyway
    const sim = await merchant.send('post', `/api/v1/transactions/${paymentId}/simulate`, { outcome: 'paid' });
    expect(sim.status).toBe(409); // simulation is only for open payments...
    const attempt = (await PaymentAttempt.findOne({ where: { publicId: paymentId } }))!;
    const { getDemoProvider } = await import('../src/modules/payments/index.js');
    const { rawBody, signature } = await getDemoProvider()!.simulate(attempt.providerReference!, 'paid');
    // ...so deliver the provider's notification directly, as a late webhook would arrive
    const res = await request(app).post('/api/v1/webhooks/demo').set('Content-Type', 'application/json').set('x-bu-signature', signature).send(rawBody.toString());
    expect(res.status).toBe(200);
    const after = await waitFor(async () => {
      const a = await PaymentAttempt.findOne({ where: { publicId: paymentId } });
      return a?.status === 'needs_review' ? a : null;
    });
    expect(after.reviewReason).toBe('late_payment');
  });

  it('rejects forged demo notifications and stores nothing', async () => {
    const before = await ProviderEvent.count();
    const res = await postWebhook('demo', { event: 'transfer.funds_received', data: { id: 'DEMO_TRF_x' } }, 'not-the-secret');
    expect(res.status).toBe(401);
    expect(await ProviderEvent.count()).toBe(before);
    const ok = await postWebhook('demo', { event: 'transfer.funds_received', data: { id: 'DEMO_TRF_unknown' } }, demoWebhookSecret());
    expect(ok.status).toBe(200);
    // Authentic but unrelated events are kept for audit and marked ignored, never applied
    const stored = await waitFor(async () => {
      const e = await ProviderEvent.findOne({ where: { objectId: 'DEMO_TRF_unknown' } });
      return e && e.status !== 'received' ? e : null;
    });
    expect(stored.status).toBe('ignored');
  });
});

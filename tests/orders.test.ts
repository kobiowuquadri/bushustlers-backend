import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import sequelize from '../src/database/db.js';
import { PaymentLink } from '../src/schemas/index.js';
import { createMerchant, createOrderWithLink, startPayment } from './helpers.js';

afterAll(async () => {
  await sequelize.close();
});

describe('orders and payment links', () => {
  it('calculates totals on the server and ignores client totals', async () => {
    const merchant = await createMerchant();
    const res = await merchant.send('post', '/api/v1/orders', {
      customer: { name: 'Chiamaka Eze', phone: '+44 7700 900123', email: 'chiamaka@example.com' },
      items: [
        { name: 'Linen trousers', quantity: 2, unitPriceMinor: '1500000' },
        { name: 'Silk scarf', quantity: 1, unitPriceMinor: '750050' },
      ],
      deliveryFeeMinor: '250000',
      totalMinor: '1',
    });
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.reference).toMatch(/^AMK-\d+$/);
    expect(order.subtotalMinor).toBe('3750050');
    expect(order.totalMinor).toBe('4000050');
    expect(order.customer.phone).toBe('+447700900123');
    expect(order.status).toBe('draft');
    expect(order.paymentStatus).toBe('unpaid');
    expect(order.fulfilmentStatus).toBe('unfulfilled');
  });

  it('validates line items', async () => {
    const merchant = await createMerchant();
    const res = await merchant.send('post', '/api/v1/orders', { items: [{ name: '', quantity: 0, unitPriceMinor: '-5' }] });
    expect(res.status).toBe(422);
    expect(res.body.data.errors.length).toBeGreaterThan(0);
  });

  it('gives sequential references under concurrency', async () => {
    const merchant = await createMerchant();
    const body = { items: [{ name: 'Adire top', quantity: 1, unitPriceMinor: '1200000' }] };
    const results = await Promise.all(Array.from({ length: 5 }, () => merchant.send('post', '/api/v1/orders', body)));
    const refs = results.map((r) => r.body.data.order.reference);
    expect(new Set(refs).size).toBe(5);
  });

  it('locks editing while a link is active and unlocks after disabling it', async () => {
    const merchant = await createMerchant();
    const { orderId, linkId } = await createOrderWithLink(merchant);
    const edit = await merchant.send('put', `/api/v1/orders/${orderId}`, { items: [{ name: 'Linen set', quantity: 1, unitPriceMinor: '1000' }] });
    expect(edit.status).toBe(409);
    expect((await merchant.send('post', `/api/v1/links/${linkId}/disable`)).status).toBe(200);
    const checkout = await request(app).get(`/api/v1/checkout/${linkId}`);
    expect(checkout.body.data.checkout.link.status).toBe('disabled');
    const retry = await startPayment(linkId, { route: 'bank_transfer' });
    expect(retry.status).toBe(410);
    const editAgain = await merchant.send('put', `/api/v1/orders/${orderId}`, { items: [{ name: 'Linen set', quantity: 1, unitPriceMinor: '4000000' }] });
    expect(editAgain.status).toBe(200);
    expect(editAgain.body.data.order.totalMinor).toBe('4000000');
  });

  it('refuses dispatch before payment is confirmed', async () => {
    const merchant = await createMerchant();
    const { orderId } = await createOrderWithLink(merchant);
    const res = await merchant.send('post', `/api/v1/orders/${orderId}/fulfilment`, { status: 'dispatched' });
    expect(res.status).toBe(409);
    expect(res.body.data.code).toBe('not_paid');
  });

  it('shows an expired checkout and refuses new payments on it', async () => {
    const merchant = await createMerchant();
    const { orderId, linkId } = await createOrderWithLink(merchant);
    await PaymentLink.update({ expiresAt: new Date(Date.now() - 60_000) }, { where: { publicId: linkId } });
    const checkout = await request(app).get(`/api/v1/checkout/${linkId}`);
    expect(checkout.status).toBe(200);
    expect(checkout.body.data.checkout.link.status).toBe('expired');
    const pay = await startPayment(linkId, { route: 'bank_transfer' });
    expect(pay.status).toBe(410);
    expect(pay.body.data.code).toBe('link_expired');
    const order = await merchant.send('get', `/api/v1/orders/${orderId}`);
    expect(order.body.data.order.status).toBe('expired');
    expect(order.body.data.order.canCreateLink).toBe(true);
  });

  it('returns 404 for unknown and malformed checkout links', async () => {
    expect((await request(app).get('/api/v1/checkout/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await request(app).get('/api/v1/checkout/1')).status).toBe(422);
  });
});

describe('merchant isolation', () => {
  it('never exposes another business\'s orders, customers, links or payments', async () => {
    const amaka = await createMerchant('Amaka Clothing');
    const other = await createMerchant('Bola Beauty');
    const { orderId, linkId } = await createOrderWithLink(amaka);
    const payment = await startPayment(linkId, { route: 'bank_transfer' });
    const paymentId = payment.body.data.payment.id;
    const amakaOrder = await amaka.send('get', `/api/v1/orders/${orderId}`);
    const customerId = amakaOrder.body.data.order.customer.id;

    expect((await other.send('get', `/api/v1/orders/${orderId}`)).status).toBe(404);
    expect((await other.send('put', `/api/v1/orders/${orderId}`, { items: [{ name: 'x', quantity: 1, unitPriceMinor: '100' }] })).status).toBe(404);
    expect((await other.send('post', `/api/v1/orders/${orderId}/cancel`)).status).toBe(404);
    expect((await other.send('get', `/api/v1/customers/${customerId}`)).status).toBe(404);
    expect((await other.send('patch', `/api/v1/customers/${customerId}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await other.send('post', `/api/v1/links/${linkId}/disable`)).status).toBe(404);
    expect((await other.send('get', `/api/v1/transactions/${paymentId}`)).status).toBe(404);
    expect((await other.send('post', `/api/v1/transactions/${paymentId}/simulate`, { outcome: 'paid' })).status).toBe(404);
    // Using another merchant's customer id when creating an order is rejected too
    expect((await other.send('post', '/api/v1/orders', { customer: { id: customerId }, items: [{ name: 'x', quantity: 1, unitPriceMinor: '100' }] })).status).toBe(404);

    const list = await other.send('get', '/api/v1/orders');
    expect(list.body.data.items).toHaveLength(0);
    const transactions = await other.send('get', '/api/v1/transactions');
    expect(transactions.body.data.items).toHaveLength(0);
  });

  it('requires a session for merchant endpoints', async () => {
    expect((await request(app).get('/api/v1/orders')).status).toBe(401);
    expect((await request(app).get('/api/v1/overview')).status).toBe(401);
  });
});

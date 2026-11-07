// Development demo data for "Amaka Clothing" (fictional people and orders).
// Usage: npm run db:seed:dev -- --confirm=<DB_NAME>
// Refuses to run with APP_ENV=production or a payments provider other than the explicit demo provider.
// Repeatable: if the demo account already exists, nothing is changed.
import { config } from '../config/config.js';
import sequelize from '../database/db.js';
import { Auth, Business, BusinessMember, PaymentAttempt, PaymentLink, Settlement } from '../schemas/index.js';
import { hashPassword } from '../utils/index.js';
import { createOrderService, updateFulfilmentService } from '../services/commerce/orderService.js';
import { createPaymentLinkService } from '../services/commerce/paymentLinkService.js';
import { startPaymentService } from '../services/payments/checkoutService.js';
import { simulatePaymentService } from '../services/payments/transactionService.js';
import { simulateSettlementService } from '../services/payments/settlementService.js';
import { expirePaymentLink } from '../services/payments/expiryService.js';
import { getPaymentProvider } from '../modules/payments/index.js';

const DEMO_EMAIL = 'amaka@example.com';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'Amaka-Demo-104!';

const main = async () => {
  const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1];
  if (config.app.isProduction) throw new Error('Refusing to seed: APP_ENV=production.');
  if (confirm !== config.database.name) throw new Error('Refusing to seed: pass --confirm=<DB_NAME> matching the database you intend to seed.');
  if (getPaymentProvider().name !== 'demo') throw new Error('Refusing to seed: demo data needs PAYMENTS_PROVIDER=demo.');

  await sequelize.authenticate();
  if (await Auth.findOne({ where: { email: DEMO_EMAIL } })) {
    console.log(`Demo account ${DEMO_EMAIL} already exists; nothing to do.`);
    return;
  }

  const user = await Auth.create({ email: DEMO_EMAIL, fullName: 'Amaka Obi', password: await hashPassword(DEMO_PASSWORD), emailVerifiedAt: new Date() });
  const business = await Business.create({ name: 'Amaka Clothing', category: 'fashion', phone: '+2348031234567', orderPrefix: 'AMK' });
  await BusinessMember.create({ businessId: business.id, userId: user.id, role: 'owner' });
  const b = (await Business.findByPk(business.id))!;

  const order = async (customer: Record<string, string>, items: Array<[string, number, string]>, deliveryFeeMinor = '0', note?: string) => {
    const result = await createOrderService(b, { customer, items: items.map(([name, quantity, unitPriceMinor]) => ({ name, quantity, unitPriceMinor })), deliveryFeeMinor, note }, user.id);
    return result.data.order;
  };
  const link = async (orderId: string) => (await createPaymentLinkService(b, orderId, { expiresInHours: 72 }, user.id)).data.link!;
  const pay = async (linkId: string, body: Parameters<typeof startPaymentService>[1], outcome?: 'paid' | 'underpaid') => {
    const started = await startPaymentService(linkId, body, `seed-${linkId}-${body.route}-${Date.now()}`);
    const attemptId = started.data.payment.id;
    if (outcome) await simulatePaymentService(b, attemptId, outcome);
    return attemptId;
  };

  // AMK-101: paid by bank transfer, dispatched and delivered, settlement simulated as settled
  const o101 = await order({ name: 'Bisi Akande', phone: '08023456789', handle: '@bisi.styles' }, [['Ankara wrap dress', 1, '2850000']], '200000');
  await pay((await link(o101.id)).id, { route: 'bank_transfer' }, 'paid');
  await updateFulfilmentService(b, o101.id, { status: 'dispatched', note: 'Rider: Musa (Bodija)' }, user.id);
  await updateFulfilmentService(b, o101.id, { status: 'delivered' }, user.id);

  // AMK-102: overseas buyer paid with USDT on Tron, ready to ship
  const o102 = await order({ name: 'Chiamaka Eze', email: 'chiamaka.eze@example.com', phone: '+447700900123', handle: '@chiamaka.in.london' }, [['Aso-oke gele and wrapper set', 1, '6200000']], '0', 'Ship with DHL to London; buyer paid shipping separately');
  await pay((await link(o102.id)).id, { route: 'stablecoin', asset: 'USDT', network: 'TRX', email: 'chiamaka.eze@example.com', name: 'Chiamaka Eze' }, 'paid');

  // AMK-103: short payment held for review
  const o103 = await order({ name: 'Kemi Balogun', phone: '08134567890' }, [['Adire kaftan', 1, '3800000']]);
  await pay((await link(o103.id)).id, { route: 'bank_transfer' }, 'underpaid');

  // AMK-104: the live demo order, link active and waiting for the buyer
  const o104 = await order({ name: 'Tolu Adeyemi', phone: '08031234567', email: 'tolu.adeyemi@example.com', handle: '@tolu.wears' }, [['Linen two-piece set', 1, '4500000']]);
  const l104 = await link(o104.id);

  // AMK-105: draft not shared yet
  await order({ name: 'Ngozi Okafor', handle: '@ngozi.okafor' }, [['Silk scarf set', 1, '2500000']], '250000');

  // AMK-106: link expired without payment
  const o106 = await order({ name: 'Ifeoma Nwosu', phone: '07045678901' }, [['Kampala shirt', 2, '1100000']]);
  const l106 = await link(o106.id);
  await PaymentLink.update({ expiresAt: new Date(Date.now() - 60_000) }, { where: { publicId: l106.id } });
  const expired = await PaymentLink.findOne({ where: { publicId: l106.id } });
  await expirePaymentLink(expired!.id);

  const firstAttempt = await PaymentAttempt.findOne({ where: { businessId: b.id, status: 'confirmed' }, order: [['id', 'ASC']] });
  const settlement = firstAttempt ? await Settlement.findOne({ where: { paymentAttemptId: firstAttempt.id } }) : null;
  if (settlement) await simulateSettlementService(b, settlement.publicId, 'settled', user.id);

  console.log('Seeded Amaka Clothing (demo data, fictional people).');
  console.log(`Sign in: ${DEMO_EMAIL} (password from SEED_DEMO_PASSWORD or the documented demo default)`);
  console.log(`Live demo checkout for AMK-104: ${l104.url}`);
};

main()
  .then(() => sequelize.close())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });

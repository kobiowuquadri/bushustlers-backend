import { createHmac } from 'crypto';
import { config } from '../../config/config.js';
import { parseStablecoinOptions } from '../../constants/payments.js';
import type { PaymentProviderName } from '../../schemas/payments/paymentAttemptSchema.js';
import { logger } from '../../utils/logger.js';
import { BushaClient } from './busha/client.js';
import { BushaProvider } from './busha/provider.js';
import { DemoProvider } from './demo/provider.js';
import type { PaymentProvider } from './types.js';

export * from './types.js';
export { BushaProvider } from './busha/provider.js';
export { DemoProvider } from './demo/provider.js';
export type { DemoOutcome } from './demo/provider.js';

const { options: stablecoinOptions, rejected } = parseStablecoinOptions(config.payments.busha.stablecoinOptions);
if (rejected.length) {
  logger.warn('Ignoring stablecoin options that are not in Busha\'s documented list', { rejected });
}

// Stable per-installation secret for signing demo notifications, derived from SECRET_KEY.
export const demoWebhookSecret = () => createHmac('sha256', config.jwt.secret).update('bushustlers-demo-webhook').digest('hex');

let active: PaymentProvider | null = null;
let demo: DemoProvider | null = null;
let override: PaymentProvider | null = null;

const buildBusha = () =>
  new BushaProvider(
    new BushaClient({
      baseUrl: config.payments.busha.baseUrl,
      secretKey: config.payments.busha.secretKey,
      publicKey: config.payments.busha.publicKey,
      timeoutMs: config.payments.busha.timeoutMs,
    }),
    {
      mode: config.payments.busha.env,
      webhookSecret: config.payments.busha.webhookSecret,
      stablecoinOptions,
    },
  );

const getDemo = () => {
  if (!demo) {
    demo = new DemoProvider({ webhookSecret: demoWebhookSecret(), ngnPerUsd: config.payments.demoNgnPerUsd, stablecoinOptions });
  }
  return demo;
};

// The provider used for new payments. Selection is explicit (PAYMENTS_PROVIDER); there is no silent fallback to demo.
export const getPaymentProvider = (): PaymentProvider => {
  if (override) return override;
  if (!active) active = config.payments.provider === 'busha' ? buildBusha() : getDemo();
  return active;
};

// The provider that owns an existing attempt. Demo attempts can only be checked by the demo provider and
// Busha attempts only by Busha, so switching modes never reinterprets earlier records.
export const getProviderByName = (name: PaymentProviderName): PaymentProvider | null => {
  const current = getPaymentProvider();
  if (current.name === name) return current;
  if (name === 'demo' && config.app.env !== 'production') return getDemo();
  return null;
};

export const getDemoProvider = (): DemoProvider | null => {
  const provider = getProviderByName('demo');
  return provider instanceof DemoProvider ? provider : null;
};

// Tests only: swap in a provider wired to a fake HTTP server.
export const setPaymentProviderForTests = (provider: PaymentProvider | null) => {
  if (config.app.env !== 'test') throw new Error('Provider overrides are only allowed in tests');
  override = provider;
};

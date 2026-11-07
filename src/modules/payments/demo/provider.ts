import type { StablecoinOption } from '../../../constants/payments.js';
import DemoProviderObject from '../../../schemas/payments/demoProviderObjectSchema.js';
import type { PaymentRoute } from '../../../schemas/payments/paymentAttemptSchema.js';
import { divideDecimal, formatDecimal, parseDecimal } from '../../../utils/decimal.js';
import { randomBase62 } from '../../../utils/ids.js';
import { minorToMajor } from '../../../utils/money.js';
import { parseBushaStyleWebhook } from '../busha/provider.js';
import { computeSignature, verifyHmacSignature } from '../signature.js';
import {
  ProviderError,
  type CreateCollectionInput,
  type CreatedCollection,
  type NormalizedStatus,
  type ParsedWebhook,
  type PaymentProvider,
  type ProviderPaymentState,
} from '../types.js';

// Explicit local demo provider. It never produces real-money instructions:
// account numbers start with "DEMO-", addresses are not valid on any chain, and the rate is labelled as a demo rate.
export type DemoOutcome = 'paid' | 'underpaid' | 'overpaid' | 'processing' | 'failed' | 'expired';

const TRANSFER_STATUS: Record<string, NormalizedStatus> = {
  pending: 'pending',
  processing: 'processing',
  funds_received: 'succeeded',
  cancelled: 'cancelled',
  failed: 'failed',
};

const REQUEST_STATUS: Record<string, NormalizedStatus> = {
  pending: 'pending',
  processing: 'processing',
  completed: 'succeeded',
  under_payment: 'underpaid',
  over_payment: 'overpaid',
  expired: 'expired',
  failed: 'failed',
};

// value * numerator / denominator, rounded half up to `scale` places
const scaleBy = (value: string, numerator: bigint, denominator: string, scale: number) => {
  const d = parseDecimal(value);
  return divideDecimal(formatDecimal({ units: d.units * numerator, scale: d.scale }), denominator, scale);
};

const demoDigits = () => Array.from(randomBase62(12)).map((c) => (c.charCodeAt(0) % 10).toString()).join('').slice(0, 6);

export interface DemoProviderOptions {
  webhookSecret: string;
  ngnPerUsd: string;
  stablecoinOptions: StablecoinOption[];
}

export class DemoProvider implements PaymentProvider {
  readonly name = 'demo' as const;
  readonly mode = 'demo' as const;
  readonly capabilities = {
    bankTransfer: true,
    stablecoin: true,
    sandboxDepositSimulation: false,
    demoSimulation: true,
    settlementPayouts: false as const,
  };

  constructor(private readonly options: DemoProviderOptions) {}

  stablecoinOptions() {
    return this.options.stablecoinOptions;
  }

  async createCollection(input: CreateCollectionInput): Promise<CreatedCollection> {
    const amount = minorToMajor(input.amountMinor);
    if (input.route === 'bank_transfer') {
      const providerReference = `DEMO_TRF_${randomBase62(14)}`;
      const accountNumber = `DEMO-${demoDigits()}`;
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await DemoProviderObject.create({
        providerReference,
        kind: 'transfer',
        status: 'pending',
        reference: input.reference,
        requestedAmount: amount,
        requestedCurrency: 'NGN',
        sourceAmount: amount,
        sourceCurrency: 'NGN',
        targetAmount: amount,
        targetCurrency: 'NGN',
        network: null,
        address: accountNumber,
        expiresAt,
      });
      return {
        providerReference,
        providerStatus: 'pending',
        expiresAt,
        instructions: {
          kind: 'bank_transfer',
          bankName: 'Demo Bank (not a real bank)',
          accountNumber,
          accountName: 'BUSHUSTLERS DEMO',
          amount,
          currency: 'NGN',
          expiresAt: expiresAt.toISOString(),
          demo: true,
        },
        assetAmount: null,
        rate: null,
        rateSource: null,
        fees: [],
        settlement: { amount, currency: 'NGN' },
      };
    }

    const option = this.options.stablecoinOptions.find((o) => o.asset === input.asset && o.network === input.network);
    if (!option) throw new ProviderError('rejected', 'This stablecoin and network are not offered');
    const providerReference = `DEMO_PAYR_${randomBase62(14)}`;
    const assetAmount = divideDecimal(amount, this.options.ngnPerUsd, 6);
    const address = `demo-${option.asset.toLowerCase()}-${option.network.toLowerCase()}-${randomBase62(24)}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await DemoProviderObject.create({
      providerReference,
      kind: 'payment_request',
      status: 'pending',
      reference: input.reference,
      requestedAmount: amount,
      requestedCurrency: 'NGN',
      sourceAmount: assetAmount,
      sourceCurrency: option.asset,
      targetAmount: amount,
      targetCurrency: 'NGN',
      network: option.network,
      address,
      expiresAt,
    });
    return {
      providerReference,
      providerStatus: 'pending',
      expiresAt,
      instructions: {
        kind: 'stablecoin',
        asset: option.asset,
        network: option.network,
        networkLabel: option.networkLabel,
        address,
        memo: null,
        amount: assetAmount,
        rate: this.options.ngnPerUsd,
        rateExplained: `1 ${option.asset} = ₦${this.options.ngnPerUsd} (demo rate, not a market quote)`,
        rateSource: 'demo',
        quoteExpiresAt: expiresAt.toISOString(),
        demo: true,
      },
      assetAmount,
      rate: this.options.ngnPerUsd,
      rateSource: 'demo',
      fees: [],
      settlement: { amount, currency: 'NGN' },
    };
  }

  private async load(providerReference: string) {
    const object = await DemoProviderObject.findOne({ where: { providerReference } });
    if (!object) throw new ProviderError('not_found', 'Demo payment not found');
    // Pending demo instructions lapse like real ones
    if (object.status === 'pending' && object.expiresAt.getTime() < Date.now()) {
      await object.update({ status: object.kind === 'transfer' ? 'cancelled' : 'expired' });
    }
    return object;
  }

  async getPaymentState(route: PaymentRoute, providerReference: string): Promise<ProviderPaymentState> {
    const object = await this.load(providerReference);
    if ((route === 'bank_transfer') !== (object.kind === 'transfer')) throw new ProviderError('rejected', 'Route does not match the demo payment');
    const statusMap = object.kind === 'transfer' ? TRANSFER_STATUS : REQUEST_STATUS;
    return {
      providerReference,
      providerStatus: object.status,
      status: statusMap[object.status] || 'unknown',
      reference: object.reference,
      requested: { amount: object.requestedAmount, currency: object.requestedCurrency },
      paid: { amount: object.receivedAmount || object.sourceAmount, currency: object.sourceCurrency },
      settlement: { amount: object.targetAmount, currency: object.targetCurrency },
      fees: [],
      updatedAt: object.updatedAt,
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined) {
    return verifyHmacSignature(rawBody, signature, this.options.webhookSecret);
  }

  parseWebhook(payload: unknown): ParsedWebhook {
    return parseBushaStyleWebhook(payload);
  }

  // Changes the demo record and returns a signed, Busha-shaped notification for the normal webhook pipeline.
  async simulate(providerReference: string, outcome: DemoOutcome) {
    const object = await this.load(providerReference);
    const isTransfer = object.kind === 'transfer';
    const scale = isTransfer ? 2 : 6;
    let received: string | null = null;
    let target = object.targetAmount;
    let status: string;
    let event: string;

    switch (outcome) {
      case 'paid':
        received = object.sourceAmount;
        target = object.requestedAmount;
        status = isTransfer ? 'funds_received' : 'completed';
        event = isTransfer ? 'transfer.funds_received' : 'payment_request.completed';
        break;
      case 'underpaid':
        received = scaleBy(object.sourceAmount, 8n, '9', scale);
        target = scaleBy(object.requestedAmount, 8n, '9', 2);
        status = isTransfer ? 'funds_received' : 'under_payment';
        event = isTransfer ? 'transfer.funds_received' : 'payment_request.processing';
        break;
      case 'overpaid':
        received = scaleBy(object.sourceAmount, 11n, '10', scale);
        target = scaleBy(object.requestedAmount, 11n, '10', 2);
        status = isTransfer ? 'funds_received' : 'over_payment';
        event = isTransfer ? 'transfer.funds_received' : 'payment_request.processing';
        break;
      case 'processing':
        status = 'processing';
        event = isTransfer ? 'transfer.processing' : 'payment_request.processing';
        break;
      case 'failed':
        status = 'failed';
        event = isTransfer ? 'transfer.failed' : 'payment_request.failed';
        break;
      case 'expired':
        status = isTransfer ? 'cancelled' : 'expired';
        event = isTransfer ? 'transfer.cancelled' : 'payment_request.expired';
        break;
      default:
        throw new ProviderError('rejected', 'Unknown demo outcome');
    }

    await object.update({ status, receivedAmount: received ?? object.receivedAmount, targetAmount: target, ...(outcome === 'expired' ? { expiresAt: new Date() } : {}) });

    const body = {
      business_id: 'BUS_DEMO',
      event,
      data: {
        id: object.providerReference,
        status,
        reference: object.reference,
        source_amount: received || object.sourceAmount,
        source_currency: object.sourceCurrency,
        target_amount: target,
        target_currency: object.targetCurrency,
        simulated: true,
        updated_at: new Date().toISOString(),
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: computeSignature(rawBody, this.options.webhookSecret) };
  }
}

import { DOCUMENTED_STABLECOIN_NETWORKS, type StablecoinOption } from '../../../constants/payments.js';
import type { PaymentRoute, ProviderFee, ProviderMode } from '../../../schemas/payments/paymentAttemptSchema.js';
import { compareDecimal, isDecimalString } from '../../../utils/decimal.js';
import { minorToMajor } from '../../../utils/money.js';
import { verifyHmacSignature } from '../signature.js';
import {
  ProviderError,
  type CreateCollectionInput,
  type CreatedCollection,
  type NormalizedStatus,
  type ParsedWebhook,
  type PaymentProvider,
  type ProviderPaymentState,
} from '../types.js';
import type { BushaClient, BushaFee, BushaPaymentRequest, BushaTransfer } from './client.js';

const TRANSFER_STATUS: Record<string, NormalizedStatus> = {
  pending: 'pending',
  processing: 'processing',
  // A deposit stops at funds_received; conversions continue to funds_converted / completed
  funds_received: 'succeeded',
  funds_converted: 'succeeded',
  completed: 'succeeded',
  cancelled: 'cancelled',
  failed: 'failed',
};

const PAYMENT_REQUEST_STATUS: Record<string, NormalizedStatus> = {
  pending: 'pending',
  processing: 'processing',
  completed: 'succeeded',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: 'failed',
  under_payment: 'underpaid',
  over_payment: 'overpaid',
  multiple_deposits: 'multiple_deposits',
};

const toFees = (fees: BushaFee[] | undefined): ProviderFee[] =>
  (fees || [])
    .filter((fee) => isDecimalString(fee?.amount?.amount) && typeof fee?.amount?.currency === 'string')
    .map((fee) => ({ name: String(fee.name || 'Provider fee').slice(0, 80), amount: fee.amount!.amount!, currency: fee.amount!.currency!.toUpperCase(), type: fee.type }));

const toDate = (value: string | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const amountOrNull = (amount: string | undefined, currency: string | undefined) =>
  isDecimalString(amount) && typeof currency === 'string' && currency ? { amount, currency: currency.toUpperCase() } : null;

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const asString = (value: unknown) => (typeof value === 'string' && value ? value : null);

export interface BushaProviderOptions {
  mode: Extract<ProviderMode, 'sandbox' | 'production'>;
  webhookSecret: string;
  stablecoinOptions: StablecoinOption[];
}

export class BushaProvider implements PaymentProvider {
  readonly name = 'busha' as const;
  readonly mode: 'sandbox' | 'production';
  readonly capabilities;

  constructor(private readonly client: BushaClient, private readonly options: BushaProviderOptions) {
    this.mode = options.mode;
    this.capabilities = {
      bankTransfer: true,
      stablecoin: options.stablecoinOptions.length > 0,
      sandboxDepositSimulation: options.mode === 'sandbox',
      demoSimulation: false,
      settlementPayouts: false as const,
    };
  }

  stablecoinOptions() {
    return this.options.stablecoinOptions;
  }

  async createCollection(input: CreateCollectionInput): Promise<CreatedCollection> {
    return input.route === 'bank_transfer' ? this.createBankTransfer(input) : this.createStablecoinRequest(input);
  }

  // NGN bank transfer: a quote with a temporary bank account pay-in, finalised into a transfer
  // (docs.busha.io/guides/deposits/process-fiat-deposits). Quotes are valid for 3 minutes, so both calls run back to back.
  private async createBankTransfer(input: CreateCollectionInput): Promise<CreatedCollection> {
    const amount = minorToMajor(input.amountMinor);
    const quote = await this.client.createQuote({
      source_currency: 'NGN',
      target_currency: 'NGN',
      source_amount: amount,
      pay_in: { type: 'temporary_bank_account' },
      reference: input.reference,
    });
    if (!quote?.id) throw new ProviderError('rejected', 'Provider did not return a quote');

    const transfer = await this.client.createTransfer(quote.id);
    const details = transfer?.pay_in?.recipient_details;
    if (!transfer?.id || !details?.account_number || !details.bank_name) {
      throw new ProviderError('rejected', 'Provider did not return bank transfer details');
    }
    // Never show instructions for an amount or currency other than the order total
    if (transfer.source_currency?.toUpperCase() !== 'NGN' || !isDecimalString(transfer.source_amount) || compareDecimal(transfer.source_amount, amount) !== 0) {
      throw new ProviderError('rejected', 'Provider returned an unexpected amount for this order');
    }
    const expiresAt = toDate(transfer.pay_in?.expires_at);
    return {
      providerReference: transfer.id,
      providerStatus: transfer.status,
      expiresAt,
      instructions: {
        kind: 'bank_transfer',
        bankName: details.bank_name,
        accountNumber: details.account_number,
        accountName: details.account_name || '',
        amount: transfer.source_amount,
        currency: 'NGN',
        expiresAt: expiresAt?.toISOString() ?? null,
        demo: false,
      },
      assetAmount: null,
      rate: null,
      rateSource: null,
      fees: toFees(transfer.fees),
      settlement: amountOrNull(transfer.target_amount, transfer.target_currency),
    };
  }

  // Stablecoin: a fiat-first payment request; Busha quotes the exact asset amount for the network
  // (docs.busha.io/guides/payment-requests/create-first-payment). Funds settle to the NGN balance.
  private async createStablecoinRequest(input: CreateCollectionInput): Promise<CreatedCollection> {
    const option = this.options.stablecoinOptions.find((o) => o.asset === input.asset && o.network === input.network);
    if (!option) throw new ProviderError('rejected', 'This stablecoin and network are not offered');
    if (!input.buyer.email) throw new ProviderError('rejected', 'An email address is required for stablecoin payments');

    const additionalInfo: Record<string, string> = { email: input.buyer.email, source: 'bushustlers_checkout' };
    if (input.buyer.name) additionalInfo.name = input.buyer.name;
    if (input.buyer.phone) additionalInfo.phone_number = input.buyer.phone;

    const request = await this.client.createPaymentRequest({
      additional_info: additionalInfo,
      quote_amount: minorToMajor(input.amountMinor),
      quote_currency: 'NGN',
      source_currency: option.asset,
      target_currency: 'NGN',
      pay_in: { type: 'address', network: option.network },
      reference: input.reference,
    });
    const payIn = request?.pay_in;
    if (!request?.id || !payIn?.address || !isDecimalString(request.source_amount)) {
      throw new ProviderError('rejected', 'Provider did not return a payment address and amount');
    }
    if (request.source_currency?.toUpperCase() !== option.asset || (payIn.network && payIn.network.toUpperCase() !== option.network)) {
      throw new ProviderError('rejected', 'Provider returned a different asset or network than requested');
    }
    const quoteExpiresAt = toDate(request.expires_at) || toDate(payIn.expires_at);
    return {
      providerReference: request.id,
      providerStatus: request.status,
      expiresAt: quoteExpiresAt,
      instructions: {
        kind: 'stablecoin',
        asset: option.asset,
        network: option.network,
        networkLabel: option.networkLabel,
        address: payIn.address,
        memo: payIn.memo || null,
        amount: request.source_amount,
        rate: isDecimalString(request.rate?.rate) ? request.rate!.rate! : null,
        rateExplained: request.rate?.rate_explained || null,
        rateSource: 'provider_quote',
        quoteExpiresAt: quoteExpiresAt?.toISOString() ?? null,
        demo: false,
      },
      assetAmount: request.source_amount,
      rate: isDecimalString(request.rate?.rate) ? request.rate!.rate! : null,
      rateSource: 'provider_quote',
      fees: toFees(request.fees),
      settlement: amountOrNull(request.target_amount, request.target_currency),
    };
  }

  async getPaymentState(route: PaymentRoute, providerReference: string): Promise<ProviderPaymentState> {
    if (route === 'bank_transfer') {
      const transfer: BushaTransfer = await this.client.getTransfer(providerReference);
      if (transfer?.id !== providerReference) throw new ProviderError('rejected', 'Provider returned a different transfer');
      return {
        providerReference,
        providerStatus: transfer.status,
        status: TRANSFER_STATUS[transfer.status] || 'unknown',
        reference: transfer.reference || null,
        // A transfer has no separate "requested" amount: source_amount is what the provider reports for the deposit
        requested: null,
        paid: amountOrNull(transfer.source_amount, transfer.source_currency),
        settlement: amountOrNull(transfer.target_amount, transfer.target_currency),
        fees: toFees(transfer.fees),
        updatedAt: toDate(transfer.updated_at),
      };
    }
    const request: BushaPaymentRequest = await this.client.getPaymentRequest(providerReference);
    if (request?.id !== providerReference) throw new ProviderError('rejected', 'Provider returned a different payment request');
    return {
      providerReference,
      providerStatus: request.status,
      status: PAYMENT_REQUEST_STATUS[request.status] || 'unknown',
      reference: request.reference || null,
      requested: amountOrNull(request.requested_amount, request.currency),
      paid: amountOrNull(request.source_amount, request.source_currency),
      settlement: amountOrNull(request.target_amount, request.target_currency),
      fees: toFees(request.fees),
      updatedAt: toDate(request.updated_at),
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined) {
    return verifyHmacSignature(rawBody, signature, this.options.webhookSecret);
  }

  parseWebhook(payload: unknown): ParsedWebhook {
    return parseBushaStyleWebhook(payload);
  }

  async simulateDeposit(transferId: string, status: 'completed' | 'failed') {
    if (this.mode !== 'sandbox') throw new ProviderError('misconfigured', 'Deposit simulation is only available in the Busha sandbox');
    await this.client.simulateDeposit(transferId, status);
  }
}

// Busha webhook body: { business_id, event, data } (docs.busha.io/guides/webhooks/webhook-events).
export const parseBushaStyleWebhook = (payload: unknown): ParsedWebhook => {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const eventType = (asString(body.event) || 'unknown').slice(0, 64);
  if (eventType.startsWith('transfer.')) {
    return { eventType, objectType: 'transfer', objectId: asString(data.id), reference: asString(data.reference), accountNumber: null, depositTotal: null };
  }
  if (eventType.startsWith('payment_request.')) {
    return { eventType, objectType: 'payment_request', objectId: asString(data.id), reference: asString(data.reference), accountNumber: null, depositTotal: null };
  }
  if (eventType === 'deposit.success') {
    return {
      eventType,
      objectType: 'deposit',
      objectId: asString(data.id),
      reference: asString(data.reference),
      accountNumber: asString(data.account_number),
      depositTotal: amountOrNull(asString(data.total) || undefined, asString(data.currency) || undefined),
    };
  }
  return { eventType, objectType: 'other', objectId: asString(data.id), reference: null, accountNumber: null, depositTotal: null };
};

export const isDocumentedNetwork = (asset: string, network: string) => Boolean(DOCUMENTED_STABLECOIN_NETWORKS[asset]?.[network]);

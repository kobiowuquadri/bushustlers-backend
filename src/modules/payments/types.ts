import type { StablecoinOption } from '../../constants/payments.js';
import type { PaymentInstructions, PaymentRoute, ProviderFee, ProviderMode, PaymentProviderName } from '../../schemas/payments/paymentAttemptSchema.js';

// Provider-independent view of a payment, produced from an authenticated provider lookup.
export type NormalizedStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'underpaid'
  | 'overpaid'
  | 'multiple_deposits'
  | 'unknown';

export interface Amount {
  amount: string; // exact decimal string in major units
  currency: string;
}

export interface CreateCollectionInput {
  reference: string;
  route: PaymentRoute;
  amountMinor: bigint; // order total in NGN kobo
  asset?: string;
  network?: string;
  buyer: { email: string | null; name: string | null; phone: string | null };
}

export interface CreatedCollection {
  providerReference: string;
  providerStatus: string;
  expiresAt: Date | null;
  instructions: PaymentInstructions;
  assetAmount: string | null;
  rate: string | null;
  rateSource: 'provider_quote' | 'demo' | null;
  fees: ProviderFee[];
  settlement: Amount | null;
}

export interface ProviderPaymentState {
  providerReference: string;
  providerStatus: string;
  status: NormalizedStatus;
  reference: string | null; // our reference, when the provider echoes it
  requested: Amount | null; // the amount the provider was asked to collect (NGN)
  paid: Amount | null; // the amount the provider reports for the buyer's payment
  settlement: Amount | null; // the amount credited after conversion/fees
  fees: ProviderFee[];
  updatedAt: Date | null;
}

export interface ParsedWebhook {
  eventType: string;
  objectType: 'transfer' | 'payment_request' | 'deposit' | 'other';
  objectId: string | null;
  reference: string | null;
  accountNumber: string | null;
  depositTotal: Amount | null;
}

export interface ProviderCapabilities {
  bankTransfer: boolean;
  stablecoin: boolean;
  // Busha's documented sandbox endpoint that simulates a deposit to a pending transfer
  sandboxDepositSimulation: boolean;
  // Explicit local demo simulation (never a real provider)
  demoSimulation: boolean;
  // Payouts to merchant bank accounts are not integrated in this release
  settlementPayouts: false;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly mode: ProviderMode;
  readonly capabilities: ProviderCapabilities;
  stablecoinOptions(): StablecoinOption[];
  createCollection(input: CreateCollectionInput): Promise<CreatedCollection>;
  getPaymentState(route: PaymentRoute, providerReference: string): Promise<ProviderPaymentState>;
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(payload: unknown): ParsedWebhook;
}

export type ProviderErrorKind = 'unavailable' | 'rejected' | 'not_found' | 'misconfigured';

// Provider failures carry a category the API can act on, plus a sanitised provider message (no headers or keys).
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;

  constructor(kind: ProviderErrorKind, message: string, httpStatus: number | null = null, providerCode: string | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
  }
}

import { describe, expect, it } from 'vitest';
import { addDecimal, compareDecimal, divideDecimal, roundDecimal, subtractDecimal } from '../src/utils/decimal.js';
import { basisPointsOf, formatNaira, majorToMinor, minorToMajor } from '../src/utils/money.js';
import { computeSignature, verifyHmacSignature } from '../src/modules/payments/signature.js';
import { parseStablecoinOptions } from '../src/constants/payments.js';
import { suggestOrderPrefix } from '../src/constants/business.js';
import { decideTransition } from '../src/services/payments/reconciliationService.js';
import { platformFeeFor } from '../src/services/payments/reconciliationService.js';
import type { ProviderPaymentState } from '../src/modules/payments/types.js';

describe('exact decimals (no floating point)', () => {
  it('compares, adds and subtracts exactly', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
    expect(subtractDecimal('30.000001', '0.000001')).toBe('30');
    expect(compareDecimal('29.999999', '30')).toBe(-1);
  });
  it('rounds half up and divides', () => {
    expect(roundDecimal('45000.005', 2)).toBe('45000.01');
    expect(divideDecimal('45000', '1500', 6)).toBe('30.000000');
    expect(divideDecimal('10', '3', 2)).toBe('3.33');
  });
});

describe('money in minor units', () => {
  it('converts between kobo and naira strings', () => {
    expect(minorToMajor(4500000n)).toBe('45000');
    expect(minorToMajor(4500050n)).toBe('45000.5');
    expect(majorToMinor('45000.50')).toBe(4500050n);
    expect(formatNaira(4500000n)).toBe('₦45,000');
  });
  it('calculates proposed fees consistently with the pricing page', () => {
    // 1% of ₦45,000 = ₦450
    expect(platformFeeFor('bank_transfer', 4500000n)).toBe(45000n);
    // 1% of ₦250,000 = ₦2,500, capped at ₦1,000
    expect(platformFeeFor('bank_transfer', 25000000n)).toBe(100000n);
    // 1.5% of ₦45,000 = ₦675
    expect(platformFeeFor('stablecoin', 4500000n)).toBe(67500n);
    expect(basisPointsOf(1n, 100)).toBe(0n);
    expect(basisPointsOf(50n, 100)).toBe(1n); // 0.5 kobo rounds half up
  });
});

describe('webhook signatures', () => {
  it('verifies base64 HMAC-SHA256 of the exact raw bytes', () => {
    const body = Buffer.from('{"event":"transfer.funds_received","data":{"id":"TRF_1"}}');
    const signature = computeSignature(body, 'secret');
    expect(verifyHmacSignature(body, signature, 'secret')).toBe(true);
    expect(verifyHmacSignature(body, signature, 'other-secret')).toBe(false);
    // Re-serialised JSON (different whitespace) must not verify
    expect(verifyHmacSignature(Buffer.from('{"event": "transfer.funds_received","data":{"id":"TRF_1"}}'), signature, 'secret')).toBe(false);
    expect(verifyHmacSignature(body, undefined, 'secret')).toBe(false);
    expect(verifyHmacSignature(body, 'not-base64!!', 'secret')).toBe(false);
  });
});

describe('configuration helpers', () => {
  it('only offers documented stablecoin networks', () => {
    const { options, rejected } = parseStablecoinOptions('USDT:TRX,usdc:base,USDT:DOGE,BTC:BTC');
    expect(options.map((o) => `${o.asset}:${o.network}`)).toEqual(['USDT:TRX', 'USDC:BASE']);
    expect(rejected).toEqual(['USDT:DOGE', 'BTC:BTC']);
  });
  it('suggests AMK for Amaka Clothing', () => {
    expect(suggestOrderPrefix('Amaka Clothing')).toBe('AMK');
  });
});

const state = (status: ProviderPaymentState['status'], paid = '45000', currency = 'NGN'): ProviderPaymentState => ({
  providerReference: 'TRF_1',
  providerStatus: status,
  status,
  reference: null,
  requested: { amount: '45000', currency: 'NGN' },
  paid: { amount: paid, currency },
  settlement: null,
  fees: [],
  updatedAt: null,
});
const attempt = (status: string) => ({ status, route: 'bank_transfer', reference: 'BH-AMK104-x', expectedAmountMinor: '4500000', asset: null, assetAmount: null, receivedAmountMinor: null }) as never;

describe('payment state machine', () => {
  it('confirms only a verified full payment', () => {
    expect(decideTransition(attempt('awaiting_payment'), state('succeeded'), false)).toEqual({ next: 'confirmed' });
  });
  it('never downgrades a confirmed payment when a late pending/processing event arrives', () => {
    expect(decideTransition(attempt('confirmed'), state('pending'), false)).toBeNull();
    expect(decideTransition(attempt('confirmed'), state('processing'), false)).toBeNull();
    expect(decideTransition(attempt('processing'), state('pending'), false)).toBeNull();
  });
  it('holds wrong amounts and currencies for review', () => {
    expect(decideTransition(attempt('awaiting_payment'), state('succeeded', '40000'), false)).toEqual({ next: 'needs_review', reviewReason: 'underpayment' });
    expect(decideTransition(attempt('awaiting_payment'), state('succeeded', '50000'), false)).toEqual({ next: 'needs_review', reviewReason: 'overpayment' });
    expect(decideTransition(attempt('awaiting_payment'), state('succeeded', '45000', 'USD'), false)).toEqual({ next: 'needs_review', reviewReason: 'currency_mismatch' });
  });
  it('flags a second genuine payment instead of discarding it', () => {
    expect(decideTransition(attempt('awaiting_payment'), state('succeeded'), true)).toEqual({ next: 'needs_review', reviewReason: 'duplicate_payment' });
  });
  it('keeps funds that arrive after expiry in reconciliation', () => {
    expect(decideTransition(attempt('expired'), state('succeeded'), false)).toEqual({ next: 'needs_review', reviewReason: 'late_payment' });
    expect(decideTransition(attempt('cancelled'), state('processing'), false)).toEqual({ next: 'needs_review', reviewReason: 'late_payment' });
  });
});

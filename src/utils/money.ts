import { formatDecimal, parseDecimal, roundDecimal } from './decimal.js';

// Fiat amounts are stored and computed as integer minor units (kobo for NGN) using BigInt.
export const NGN_EXPONENT = 2;
export const MAX_ORDER_MINOR = 10_000_000_000n; // ₦100,000,000.00 per order

export const MINOR_PATTERN = /^\d{1,15}$/;

export const toMinor = (value: string | number | bigint | null | undefined): bigint => {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Minor-unit amounts must be safe integers');
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value)) throw new Error('Minor-unit amounts must be whole numbers');
  return BigInt(value);
};

// 4500000n => "45000" ; 4500050n => "45000.5" — the decimal string format Busha's API accepts.
export const minorToMajor = (minor: bigint, exponent = NGN_EXPONENT) => formatDecimal({ units: minor, scale: exponent });

// "45000.50" => 4500050n. Values with more precision than the currency supports are rounded half up.
export const majorToMinor = (major: string, exponent = NGN_EXPONENT) => {
  const rounded = roundDecimal(major, exponent);
  const { units } = parseDecimal(rounded);
  return units;
};

// Basis-point fee rounded half up to the nearest minor unit, optionally capped.
export const basisPointsOf = (amountMinor: bigint, bps: number, capMinor?: number | bigint | null) => {
  if (amountMinor <= 0n || bps <= 0) return 0n;
  const fee = (amountMinor * BigInt(bps) + 5_000n) / 10_000n;
  if (capMinor === null || capMinor === undefined) return fee;
  const cap = BigInt(capMinor);
  return cap > 0n && fee > cap ? cap : fee;
};

// For human-readable text such as emails: ₦45,000 or ₦45,000.50
export const formatNaira = (minor: bigint) => {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const kobo = abs % 100n;
  return `${negative ? '-' : ''}₦${whole}${kobo ? `.${kobo.toString().padStart(2, '0')}` : ''}`;
};

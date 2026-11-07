// Exact decimal arithmetic on strings using BigInt. Money never touches JavaScript floats.
// A decimal is represented as an integer `units` scaled by 10^scale, e.g. "30.25" => { units: 3025n, scale: 2 }.

export interface Decimal {
  units: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^-?\d{1,30}(\.\d{1,30})?$/;

export const isDecimalString = (value: unknown): value is string => typeof value === 'string' && DECIMAL_PATTERN.test(value.trim());

export const parseDecimal = (value: string): Decimal => {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) throw new Error(`Invalid decimal: ${trimmed.slice(0, 40)}`);
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const units = BigInt(whole + fraction) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
};

const rescale = (d: Decimal, scale: number): bigint => {
  if (scale < d.scale) throw new Error('Cannot reduce scale without rounding');
  return d.units * 10n ** BigInt(scale - d.scale);
};

export const compareDecimal = (a: string, b: string): -1 | 0 | 1 => {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const diff = rescale(x, scale) - rescale(y, scale);
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
};

export const formatDecimal = ({ units, scale }: Decimal, { trimZeros = true, minScale = 0 } = {}): string => {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  let whole = scale ? digits.slice(0, -scale) : digits;
  let fraction = scale ? digits.slice(-scale) : '';
  if (trimZeros) fraction = fraction.replace(/0+$/, '');
  if (fraction.length < minScale) fraction = fraction.padEnd(minScale, '0');
  whole = whole.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

export const addDecimal = (a: string, b: string): string => {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return formatDecimal({ units: rescale(x, scale) + rescale(y, scale), scale });
};

export const subtractDecimal = (a: string, b: string): string => {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return formatDecimal({ units: rescale(x, scale) - rescale(y, scale), scale });
};

// Round half up (away from zero) to `scale` decimal places.
export const roundDecimal = (value: string, scale: number): string => {
  const d = parseDecimal(value);
  if (d.scale <= scale) return formatDecimal({ units: rescale(d, scale), scale }, { trimZeros: false, minScale: scale });
  const factor = 10n ** BigInt(d.scale - scale);
  const negative = d.units < 0n;
  const abs = negative ? -d.units : d.units;
  let q = abs / factor;
  if ((abs % factor) * 2n >= factor) q += 1n;
  return formatDecimal({ units: negative ? -q : q, scale }, { trimZeros: false, minScale: scale });
};

// Divide two decimals and round half up to `scale` places, e.g. NGN amount / NGN-per-USD rate.
export const divideDecimal = (numerator: string, denominator: string, scale: number): string => {
  const n = parseDecimal(numerator);
  const d = parseDecimal(denominator);
  if (d.units === 0n) throw new Error('Division by zero');
  // n/d = (n.units / 10^n.scale) / (d.units / 10^d.scale); compute with one extra digit for rounding.
  const numeratorUnits = n.units * 10n ** BigInt(scale + 1 + d.scale);
  const denominatorUnits = d.units * 10n ** BigInt(n.scale);
  const raw = numeratorUnits / denominatorUnits;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  let q = abs / 10n;
  if (abs % 10n >= 5n) q += 1n;
  return formatDecimal({ units: negative ? -q : q, scale }, { trimZeros: false, minScale: scale });
};

import { randomBytes } from 'crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Unbiased base62 string from a CSPRNG (rejection sampling avoids modulo bias).
export const randomBase62 = (length: number) => {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
};

// Public identifiers for API resources, e.g. ord_8fK2…  ~119 bits of randomness, never sequential.
export const publicId = (prefix: 'ord' | 'cus' | 'pat' | 'stl' | 'ses') => `${prefix}_${randomBase62(20)}`;

// Checkout link identifiers are capabilities (anyone holding one can open the checkout), so they get 128+ bits.
export const linkPublicId = () => randomBase62(22);

// Reference we send to the provider for each payment attempt. Busha requires 12–64 characters.
export const attemptReference = (orderReference: string) => `BH-${orderReference.replace(/[^A-Z0-9]/gi, '')}-${randomBase62(10)}`;

export const PUBLIC_ID_PATTERN = /^(ord|cus|pat|stl)_[0-9A-Za-z]{20}$/;
export const LINK_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

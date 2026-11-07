import { createHmac, timingSafeEqual } from 'crypto';

// Busha: "perform a HMAC hash of the request body using the Webhook secret as the key" and compare it with
// the base64-encoded x-bu-signature header (docs.busha.io/guides/webhooks/setup#verifying-webhook-signature).
// The raw bytes must be used: re-serialising parsed JSON can change the body and break the signature.
export const computeSignature = (rawBody: Buffer, secret: string) => createHmac('sha256', secret).update(rawBody).digest('base64');

export const verifyHmacSignature = (rawBody: Buffer, signature: string | undefined, secret: string) => {
  if (!secret || !signature) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.trim(), 'base64');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

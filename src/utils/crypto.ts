import { createHash, randomBytes, randomInt } from 'crypto'

// Generate a numeric verification code (OTP); uses a secure RNG since Math.random is predictable
export const generateVerificationCode = (length = 6) => {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0')
}

// Generate a URL-safe random token, e.g. for magic links or password reset links
export const generateRandomToken = (bytes = 32) => {
  return randomBytes(bytes).toString('base64url')
}

// Hash a token before storing it, so a leaked database row can't be used as the token itself
export const hashToken = (token: string) => {
  return createHash('sha256').update(token).digest('hex')
}

import jwt from 'jsonwebtoken'
import { config } from '../config/config.js'

export type TokenType = 'access'

export interface TokenPayload {
  id: number
  email: string
  // Session the access token belongs to; revoking the session invalidates the token immediately
  sid: string
}

export interface DecodedToken extends TokenPayload, jwt.JwtPayload {
  type: TokenType
}

type VerifyTokenResult =
  | { success: true; decoded: DecodedToken }
  | { success: false; error: string; expired: boolean }

// generate token
export const generateToken = (payload: object, expiresIn: jwt.SignOptions['expiresIn'] = '15m') => {
  return jwt.sign(payload, config.jwt.secret, { expiresIn, algorithm: 'HS256' })
}

// The type claim stops any other kind of signed token from being used as an access token
export const generateAccessToken = (payload: TokenPayload) => {
  return generateToken({ ...payload, type: 'access' }, config.jwt.accessTokenExpiresIn)
}

// verify token, optionally requiring a specific token type
export const verifyToken = (token: string, type?: TokenType): VerifyTokenResult => {
  try {
    const decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as DecodedToken
    if (type && decoded.type !== type) {
      return { success: false, error: 'Invalid token type', expired: false }
    }
    return { success: true, decoded }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid or expired token',
      expired: error instanceof jwt.TokenExpiredError
    }
  }
}

// Read a token's expiry date without verifying it, e.g. to store next to the token
export const getTokenExpiry = (token: string) => {
  const decoded = jwt.decode(token) as jwt.JwtPayload | null
  return decoded?.exp ? new Date(decoded.exp * 1000) : null
}

import type { CookieOptions, Response } from 'express'
import { config } from '../config/config.js'

// Session cookies are HttpOnly, so browser JavaScript never sees the tokens.
// With COOKIE_SECURE (default outside local development) the __Host- prefix pins them to the exact host over HTTPS.
const prefix = config.session.cookieSecure ? '__Host-' : ''

export const COOKIE_NAMES = {
  access: `${prefix}bh_access`,
  refresh: `${prefix}bh_session`,
  // Readable by the frontend: it echoes the value in the X-CSRF-Token header (double-submit pattern)
  csrf: `${prefix}bh_csrf`,
}

const base: CookieOptions = {
  secure: config.session.cookieSecure,
  sameSite: 'lax',
  path: '/',
}

export const setSessionCookies = (res: Response, tokens: { accessToken: string; refreshToken: string; sessionExpiresAt: Date }) => {
  res.cookie(COOKIE_NAMES.access, tokens.accessToken, { ...base, httpOnly: true, expires: tokens.sessionExpiresAt })
  res.cookie(COOKIE_NAMES.refresh, tokens.refreshToken, { ...base, httpOnly: true, expires: tokens.sessionExpiresAt })
}

export const setAccessCookie = (res: Response, accessToken: string, sessionExpiresAt: Date) => {
  res.cookie(COOKIE_NAMES.access, accessToken, { ...base, httpOnly: true, expires: sessionExpiresAt })
}

export const clearSessionCookies = (res: Response) => {
  res.clearCookie(COOKIE_NAMES.access, { ...base, httpOnly: true })
  res.clearCookie(COOKIE_NAMES.refresh, { ...base, httpOnly: true })
}

export const setCsrfCookie = (res: Response, token: string) => {
  res.cookie(COOKIE_NAMES.csrf, token, { ...base, httpOnly: false, maxAge: 1000 * 60 * 60 * 24 * 30 })
}

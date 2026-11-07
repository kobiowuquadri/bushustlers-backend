import { INTERNAL_SERVER_ERROR } from '../constants/statusCode.js'

// Throw anywhere in a request; the error handler middleware turns it into a response with this status.
// `code` is a stable machine-readable value the frontend can branch on (e.g. "access_expired").
export class AppError extends Error {
  readonly statusCode: number
  readonly data: unknown
  readonly code?: string

  constructor(message: string, statusCode = INTERNAL_SERVER_ERROR, data: unknown = {}, code?: string) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.data = code ? { ...(typeof data === 'object' && data ? data : {}), code } : data
  }
}

export const appError = (statusCode: number, code: string, message: string, data: Record<string, unknown> = {}) =>
  new AppError(message, statusCode, data, code)

import type { NextFunction, Request, RequestHandler, Response } from 'express'

// Express 4 ignores rejected promises from async handlers; forward them to the error handler instead
export const asyncHandler = <P = Record<string, string>, ResBody = any, ReqBody = any>(
  handler: (req: Request<P, ResBody, ReqBody>, res: Response<ResBody>, next: NextFunction) => Promise<unknown>
): RequestHandler<P, ResBody, ReqBody> => {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}

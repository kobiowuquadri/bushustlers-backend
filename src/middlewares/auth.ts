import { Request, Response, NextFunction } from 'express';
import { verifyToken, messageHandler } from '../utils/index.js';
import { COOKIE_NAMES } from '../utils/cookies.js';
import { FORBIDDEN, UNAUTHORIZED } from '../constants/statusCode.js';
import { AuthSession, Business, BusinessMember } from '../schemas/index.js';

const deny = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json(messageHandler(message, false, status, { code }));

// Requires a valid access-token cookie whose session has not been revoked, and exposes it as req.user.
// "access_expired" tells the frontend to call /auth/refresh and retry once.
export const verify = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.[COOKIE_NAMES.access];
    if (!token) return deny(res, UNAUTHORIZED, 'unauthenticated', 'Sign in to continue');

    const result = verifyToken(token, 'access');
    if (!result.success) {
      return result.expired
        ? deny(res, UNAUTHORIZED, 'access_expired', 'Session needs refreshing')
        : deny(res, UNAUTHORIZED, 'unauthenticated', 'Sign in to continue');
    }

    const session = await AuthSession.findOne({ where: { publicId: result.decoded.sid } });
    if (!session || session.userId !== result.decoded.id || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      return deny(res, UNAUTHORIZED, 'session_ended', 'Your session has ended. Sign in again.');
    }

    req.user = { ...result.decoded, sessionId: session.id };
    next();
  } catch (error) {
    next(error);
  }
};

// Loads the signed-in user's business. Every merchant query is then scoped by req.business.id.
export const requireBusiness = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const membership = await BusinessMember.findOne({ where: { userId: req.user!.id }, order: [['id', 'ASC']] });
    if (!membership) return deny(res, FORBIDDEN, 'onboarding_required', 'Set up your business to continue');
    const business = await Business.findByPk(membership.businessId);
    if (!business) return deny(res, FORBIDDEN, 'onboarding_required', 'Set up your business to continue');
    req.membership = membership;
    req.business = business;
    next();
  } catch (error) {
    next(error);
  }
};

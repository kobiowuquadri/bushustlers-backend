import type { DecodedToken } from '../utils/token.js';
import type { Business, BusinessMember } from '../schemas/business/businessSchema.js';

declare global {
  namespace Express {
    interface Request {
      // Set by the requestContext middleware; echoed in the X-Request-Id response header
      id: string;
      // Set by the verify middleware
      user?: DecodedToken & { sessionId: number };
      // Set by the requireBusiness middleware: the signed-in user's business and membership
      business?: Business;
      membership?: BusinessMember;
    }
  }
}

export {};

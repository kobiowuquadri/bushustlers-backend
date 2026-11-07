import { Request, Response } from "express";
import {
  registerService,
  loginService,
  refreshSessionService,
  logoutService,
  logoutOtherSessionsService,
  getProfileService,
  updateProfileService,
  resendVerificationService,
  verifyEmailService,
  forgotPasswordService,
  resetPasswordService,
  changePasswordService,
} from "../../services/users/authService.js";
import { ChangePasswordRequest, LoginRequest, RegisterRequest, ResetPasswordRequest, SessionTokens } from "../../types/users/auth.js";
import { asyncHandler, messageHandler, sendResponse } from "../../utils/index.js";
import { COOKIE_NAMES, clearSessionCookies, setAccessCookie, setSessionCookies } from "../../utils/cookies.js";
import { SUCCESS } from "../../constants/statusCode.js";

const clientInfo = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

// Tokens only ever leave the server as HttpOnly cookies
const applyTokens = (res: Response, tokens: SessionTokens) => {
  if (tokens.refreshToken) {
    setSessionCookies(res, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, sessionExpiresAt: tokens.sessionExpiresAt });
  } else {
    setAccessCookie(res, tokens.accessToken, tokens.sessionExpiresAt);
  }
};

// The CSRF cookie itself is issued by ensureCsrfCookie; this endpoint lets the frontend make sure it exists
export const csrfController = (req: Request, res: Response) => {
  sendResponse(res, messageHandler('OK', true, SUCCESS));
};

export const registerController = asyncHandler(async (req: Request<{}, {}, RegisterRequest>, res: Response) => {
  const { response, tokens } = await registerService(req.body, clientInfo(req));
  applyTokens(res, tokens);
  sendResponse(res, response);
});

export const loginController = asyncHandler(async (req: Request<{}, {}, LoginRequest>, res: Response) => {
  const { response, tokens } = await loginService(req.body, clientInfo(req));
  applyTokens(res, tokens);
  sendResponse(res, response);
});

export const refreshTokenController = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { response, tokens } = await refreshSessionService(req.cookies?.[COOKIE_NAMES.refresh]);
    applyTokens(res, tokens);
    sendResponse(res, response);
  } catch (error) {
    clearSessionCookies(res);
    throw error;
  }
});

// req.user is always set here because these routes run the verify middleware first
export const logoutController = asyncHandler(async (req: Request, res: Response) => {
  const result = await logoutService(req.user!.sessionId);
  clearSessionCookies(res);
  sendResponse(res, result);
});

export const logoutOthersController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await logoutOtherSessionsService(req.user!.id, req.user!.sessionId));
});

export const profileController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await getProfileService(req.user!.id));
});

export const updateProfileController = asyncHandler(async (req: Request<{}, {}, { fullName: string }>, res: Response) => {
  sendResponse(res, await updateProfileService(req.user!.id, req.body));
});

export const resendVerificationController = asyncHandler(async (req: Request, res: Response) => {
  sendResponse(res, await resendVerificationService(req.user!.id));
});

export const verifyEmailController = asyncHandler(async (req: Request<{}, {}, { token: string }>, res: Response) => {
  sendResponse(res, await verifyEmailService(req.body.token));
});

export const forgotPasswordController = asyncHandler(async (req: Request<{}, {}, { email: string }>, res: Response) => {
  sendResponse(res, await forgotPasswordService(req.body.email));
});

export const resetPasswordController = asyncHandler(async (req: Request<{}, {}, ResetPasswordRequest>, res: Response) => {
  const result = await resetPasswordService(req.body);
  clearSessionCookies(res);
  sendResponse(res, result);
});

export const changePasswordController = asyncHandler(async (req: Request<{}, {}, ChangePasswordRequest>, res: Response) => {
  sendResponse(res, await changePasswordService(req.user!.id, req.user!.sessionId, req.body));
});

import express from 'express'
import { validate } from '../../validations/index.js';
import { verify } from '../../middlewares/auth.js';
import { requireCsrf } from '../../middlewares/csrf.js';
import { authLimiter, emailLimiter, loginAccountLimiter } from '../../middlewares/rateLimiter.js';
import {
  csrfController,
  registerController,
  loginController,
  refreshTokenController,
  logoutController,
  logoutOthersController,
  profileController,
  updateProfileController,
  resendVerificationController,
  verifyEmailController,
  forgotPasswordController,
  resetPasswordController,
  changePasswordController,
} from "../../controllers/users/authController.js";
import {
  registerValidation,
  loginValidation,
  updateProfileValidation,
  verifyEmailValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  changePasswordValidation,
} from '../../validations/users/authValidations.js';

export const authRouter = express.Router()

authRouter.get('/csrf', csrfController)
authRouter.use(requireCsrf)

authRouter.post('/register', authLimiter, validate(registerValidation), registerController)
authRouter.post('/login', authLimiter, validate(loginValidation), loginAccountLimiter, loginController)
authRouter.post('/refresh', authLimiter, refreshTokenController)
authRouter.post('/logout', verify, logoutController)
authRouter.post('/logout-others', verify, logoutOthersController)
authRouter.get('/me', verify, profileController)
authRouter.patch('/me', verify, validate(updateProfileValidation), updateProfileController)
authRouter.post('/verify-email', authLimiter, validate(verifyEmailValidation), verifyEmailController)
authRouter.post('/resend-verification', verify, emailLimiter, resendVerificationController)
authRouter.post('/forgot-password', emailLimiter, validate(forgotPasswordValidation), forgotPasswordController)
authRouter.post('/reset-password', authLimiter, validate(resetPasswordValidation), resetPasswordController)
authRouter.post('/change-password', verify, validate(changePasswordValidation), changePasswordController)

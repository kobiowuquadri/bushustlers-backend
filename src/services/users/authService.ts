import { Op } from 'sequelize';
import { config } from '../../config/config.js';
import { Auth, AuthSession, AuthToken, Business, BusinessMember } from '../../schemas/index.js';
import type { AuthTokenPurpose } from '../../schemas/users/authTokenSchema.js';
import { sendMail } from '../../modules/notifications/mailer.js';
import {
  appError,
  generateAccessToken,
  generateRandomToken,
  hashPassword,
  hashToken,
  messageHandler,
  publicId,
  verifyPassword,
} from '../../utils/index.js';
import { describeError, logger } from '../../utils/logger.js';
import { CREATED, CONFLICT, NOT_FOUND, SUCCESS, UNAUTHORIZED, VALIDATION_ERROR } from '../../constants/statusCode.js';
import type { ChangePasswordRequest, ClientInfo, LoginRequest, RegisterRequest, ResetPasswordRequest, SessionTokens, UserResponse } from '../../types/users/auth.js';

const ROTATION_GRACE_MS = 30_000;
const VERIFY_TTL_HOURS = 48;
const RESET_TTL_MINUTES = 30;

// Compared against when the email is unknown, so response time does not reveal which emails exist
let dummyHash: string | null = null;
const getDummyHash = async () => (dummyHash ??= await hashPassword(generateRandomToken(16)));

// Never return the model itself: it holds the password hash
export const toUserResponse = (user: Auth): UserResponse => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  emailVerified: Boolean(user.emailVerifiedAt),
  createdAt: user.createdAt,
});

const issueTokens = (user: Auth, session: AuthSession, secret: string | null): SessionTokens => ({
  accessToken: generateAccessToken({ id: user.id, email: user.email, sid: session.publicId }),
  // Opaque refresh token: "<session id>.<secret>". Only the secret's SHA-256 hash is stored.
  refreshToken: secret ? `${session.publicId}.${secret}` : null,
  sessionExpiresAt: session.expiresAt,
});

const createSession = async (user: Auth, client: ClientInfo) => {
  const secret = generateRandomToken(32);
  const session = await AuthSession.create({
    publicId: publicId('ses'),
    userId: user.id,
    refreshTokenHash: hashToken(secret),
    userAgent: client.userAgent?.slice(0, 255) || null,
    ipAddress: client.ip?.slice(0, 64) || null,
    expiresAt: new Date(Date.now() + config.session.ttlDays * 24 * 60 * 60 * 1000),
    lastUsedAt: new Date(),
  });
  return issueTokens(user, session, secret);
};

const createAuthToken = async (userId: number, purpose: AuthTokenPurpose, ttlMs: number) => {
  // Older unused links for the same purpose stop working when a new one is issued
  await AuthToken.update({ usedAt: new Date() }, { where: { userId, purpose, usedAt: null } });
  const token = generateRandomToken(32);
  await AuthToken.create({ userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
};

const consumeAuthToken = async (token: string, purpose: AuthTokenPurpose) => {
  const record = await AuthToken.findOne({ where: { tokenHash: hashToken(token), purpose } });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) return null;
  const [updated] = await AuthToken.update({ usedAt: new Date() }, { where: { id: record.id, usedAt: null } });
  return updated === 1 ? record : null;
};

const firstName = (user: Auth) => user.fullName?.split(' ')[0] || 'there';

const sendVerificationEmail = async (user: Auth) => {
  const token = await createAuthToken(user.id, 'verify_email', VERIFY_TTL_HOURS * 60 * 60 * 1000);
  await sendMail({
    to: user.email,
    subject: 'Confirm your email for Bushustlers',
    template: 'verify-email',
    context: { name: firstName(user), link: `${config.app.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`, expiresInHours: VERIFY_TTL_HOURS },
  });
};

export const registerService = async ({ fullName, email, password }: RegisterRequest, client: ClientInfo) => {
  const existingUser = await Auth.findOne({ where: { email } });
  if (existingUser) {
    throw appError(CONFLICT, 'email_taken', 'An account with this email already exists. Sign in instead.');
  }

  const user = await Auth.create({ email, fullName, password: await hashPassword(password) });
  const tokens = await createSession(user, client);
  await sendVerificationEmail(user).catch((error) => logger.error('Verification email failed', describeError(error)));

  return { response: messageHandler('Account created', true, CREATED, { user: toUserResponse(user) }), tokens };
};

export const loginService = async ({ email, password }: LoginRequest, client: ClientInfo) => {
  const user = await Auth.findOne({ where: { email } });
  const valid = await verifyPassword(password, user ? user.password : await getDummyHash());

  // Same message for an unknown email and a wrong password, so emails can't be probed
  if (!user || !valid) {
    throw appError(UNAUTHORIZED, 'invalid_credentials', 'Email or password is incorrect');
  }

  const tokens = await createSession(user, client);
  return { response: messageHandler('Signed in', true, SUCCESS, { user: toUserResponse(user) }), tokens };
};

// Rotates the refresh token. Presenting an already-rotated token (outside a short grace window for parallel
// tabs) is treated as theft and ends the session.
export const refreshSessionService = async (rawToken: string | undefined) => {
  const ended = () => appError(UNAUTHORIZED, 'session_ended', 'Your session has ended. Sign in again.');
  const [sessionId, secret] = (rawToken || '').split('.');
  if (!sessionId || !secret) throw ended();

  const session = await AuthSession.findOne({ where: { publicId: sessionId } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) throw ended();
  const user = await Auth.findByPk(session.userId);
  if (!user) throw ended();

  const presented = hashToken(secret);
  if (presented === session.refreshTokenHash) {
    const nextSecret = generateRandomToken(32);
    await session.update({ previousTokenHash: session.refreshTokenHash, refreshTokenHash: hashToken(nextSecret), rotatedAt: new Date(), lastUsedAt: new Date() });
    return { response: messageHandler('Session refreshed', true, SUCCESS, { user: toUserResponse(user) }), tokens: issueTokens(user, session, nextSecret) };
  }
  if (presented === session.previousTokenHash && session.rotatedAt && Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS) {
    return { response: messageHandler('Session refreshed', true, SUCCESS, { user: toUserResponse(user) }), tokens: issueTokens(user, session, null) };
  }

  await session.update({ revokedAt: new Date(), revokedReason: 'refresh_reuse' });
  throw ended();
};

export const logoutService = async (sessionId: number) => {
  await AuthSession.update({ revokedAt: new Date(), revokedReason: 'logout' }, { where: { id: sessionId, revokedAt: null } });
  return messageHandler('Signed out', true, SUCCESS);
};

export const logoutOtherSessionsService = async (userId: number, keepSessionId: number) => {
  const [count] = await AuthSession.update(
    { revokedAt: new Date(), revokedReason: 'signed_out_elsewhere' },
    { where: { userId, revokedAt: null, id: { [Op.ne]: keepSessionId } } },
  );
  return messageHandler(count ? `Signed out of ${count} other ${count === 1 ? 'device' : 'devices'}` : 'No other devices were signed in', true, SUCCESS, { revoked: count });
};

export const getProfileService = async (userId: number) => {
  const user = await Auth.findByPk(userId);
  if (!user) throw appError(NOT_FOUND, 'not_found', 'User not found');

  const membership = await BusinessMember.findOne({ where: { userId }, order: [['id', 'ASC']] });
  const business = membership ? await Business.findByPk(membership.businessId) : null;

  return messageHandler('Profile retrieved successfully', true, SUCCESS, {
    user: toUserResponse(user),
    business: business ? { name: business.name, role: membership!.role } : null,
    onboardingComplete: Boolean(business),
  });
};

export const updateProfileService = async (userId: number, { fullName }: { fullName: string }) => {
  const user = await Auth.findByPk(userId);
  if (!user) throw appError(NOT_FOUND, 'not_found', 'User not found');
  await user.update({ fullName });
  return messageHandler('Profile updated', true, SUCCESS, { user: toUserResponse(user) });
};

export const resendVerificationService = async (userId: number) => {
  const user = await Auth.findByPk(userId);
  if (!user) throw appError(NOT_FOUND, 'not_found', 'User not found');
  if (user.emailVerifiedAt) return messageHandler('Your email is already confirmed', true, SUCCESS);
  await sendVerificationEmail(user);
  return messageHandler('We sent a new confirmation link', true, SUCCESS);
};

export const verifyEmailService = async (token: string) => {
  const record = await consumeAuthToken(token, 'verify_email');
  if (!record) throw appError(VALIDATION_ERROR, 'invalid_token', 'This confirmation link is invalid or has expired. Request a new one from your dashboard.');
  await Auth.update({ emailVerifiedAt: new Date() }, { where: { id: record.userId, emailVerifiedAt: null } });
  return messageHandler('Email confirmed', true, SUCCESS);
};

export const forgotPasswordService = async (email: string) => {
  const user = await Auth.findOne({ where: { email } });
  if (user) {
    const token = await createAuthToken(user.id, 'reset_password', RESET_TTL_MINUTES * 60 * 1000);
    await sendMail({
      to: user.email,
      subject: 'Reset your Bushustlers password',
      template: 'reset-password',
      context: { name: firstName(user), email: user.email, link: `${config.app.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`, expiresInMinutes: RESET_TTL_MINUTES },
    });
  }
  // Identical response either way, so the endpoint can't be used to discover accounts
  return messageHandler('If an account exists for that email, we sent a link to reset the password.', true, SUCCESS);
};

const notifyPasswordChanged = (user: Auth) =>
  sendMail({
    to: user.email,
    subject: 'Your Bushustlers password was changed',
    template: 'password-changed',
    context: { name: firstName(user), email: user.email, changedAt: new Date().toUTCString() },
  }).catch(() => undefined);

export const resetPasswordService = async ({ token, password }: ResetPasswordRequest) => {
  const record = await consumeAuthToken(token, 'reset_password');
  if (!record) throw appError(VALIDATION_ERROR, 'invalid_token', 'This reset link is invalid or has expired. Request a new one.');
  const user = await Auth.findByPk(record.userId);
  if (!user) throw appError(VALIDATION_ERROR, 'invalid_token', 'This reset link is invalid or has expired. Request a new one.');

  await user.update({ password: await hashPassword(password), passwordChangedAt: new Date(), emailVerifiedAt: user.emailVerifiedAt ?? new Date() });
  // A reset signs out every device
  await AuthSession.update({ revokedAt: new Date(), revokedReason: 'password_reset' }, { where: { userId: user.id, revokedAt: null } });
  await notifyPasswordChanged(user);
  return messageHandler('Password updated. Sign in with your new password.', true, SUCCESS);
};

export const changePasswordService = async (userId: number, sessionId: number, { currentPassword, newPassword }: ChangePasswordRequest) => {
  const user = await Auth.findByPk(userId);
  if (!user) throw appError(NOT_FOUND, 'not_found', 'User not found');
  if (!(await verifyPassword(currentPassword, user.password))) {
    throw appError(VALIDATION_ERROR, 'invalid_current_password', 'Your current password is incorrect', { errors: [{ field: 'currentPassword', message: 'Current password is incorrect' }] });
  }
  await user.update({ password: await hashPassword(newPassword), passwordChangedAt: new Date() });
  await AuthSession.update(
    { revokedAt: new Date(), revokedReason: 'password_changed' },
    { where: { userId, revokedAt: null, id: { [Op.ne]: sessionId } } },
  );
  await notifyPasswordChanged(user);
  return messageHandler('Password changed. Other devices have been signed out.', true, SUCCESS);
};

import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import * as authService from '../services/auth/authService.js';
import { REFRESH_COOKIE, refreshCookieOptions } from '../services/auth/tokenService.js';
import { serializeSession } from '../serializers/user.serializer.js';
import { buildActor } from '../services/shared/permissionResolver.js';
import env from '../config/env.js';

function setRefreshCookie(res, refresh) {
  res.cookie(REFRESH_COOKIE, refresh.raw, refreshCookieOptions(refresh.expiresAt));
}

export const login = asyncHandler(async (req, res) => {
  const { user, actor, accessToken, refresh } = await authService.login({
    email: req.body.email,
    password: req.body.password,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  setRefreshCookie(res, refresh);

  return ok(res, {
    message: 'Signed in',
    data: { accessToken, session: serializeSession(actor, user) },
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const { user, actor, accessToken, refresh: next } = await authService.refresh({
    rawToken: req.cookies?.[REFRESH_COOKIE],
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  setRefreshCookie(res, next);

  return ok(res, {
    message: 'Session refreshed',
    data: { accessToken, session: serializeSession(actor, user) },
  });
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout({ rawToken: req.cookies?.[REFRESH_COOKIE] });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(new Date(0)), expires: undefined });
  return ok(res, { message: 'Signed out' });
});

export const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutAll({ userId: req.actor.id, tenantId: req.actor.tenantId });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(new Date(0)), expires: undefined });
  return ok(res, { message: 'Signed out of all sessions' });
});

/**
 * The frontend's single source of truth for permission guards.
 *
 * Deliberately served from the server rather than decoded from the JWT on the
 * client: the client should never be parsing tokens, and this keeps one
 * authoritative shape for the session.
 */
export const me = asyncHandler(async (req, res) => {
  const { userRepository } = await import('../repositories/user.repository.js');
  const user = await userRepository.findWithRole(req.actor.id, {
    tenantId: req.actor.tenantId,
    permissions: req.actor.permissions,
  });
  const actor = user?.role ? buildActor(user, user.role) : req.actor;
  return ok(res, { data: serializeSession(actor, user) });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword({
    userId: req.actor.id,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword,
  });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(new Date(0)), expires: undefined });
  return ok(res, { message: 'Password changed. Please sign in again.' });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset({ email: req.body.email });

  // Always the same response, whether or not the address exists — otherwise
  // this endpoint enumerates accounts.
  const body = { message: 'If that email is registered, a reset link has been sent.' };

  // Until the mailer lands in Phase 10, development returns the token so the
  // flow is testable. Explicitly gated on NODE_ENV so it can never ship.
  if (!env.isProduction && result.token) {
    return ok(res, { ...body, data: { devResetToken: result.token } });
  }
  return ok(res, body);
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword({ token: req.body.token, newPassword: req.body.newPassword });
  return ok(res, { message: 'Password reset. You can now sign in.' });
});

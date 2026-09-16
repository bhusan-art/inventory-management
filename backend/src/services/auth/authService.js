import crypto from 'node:crypto';
import { User, hashPassword } from '../../models/User.js';
import { userRepository } from '../../repositories/user.repository.js';
import { buildActor } from '../shared/permissionResolver.js';
import { writeAudit } from '../shared/auditService.js';
import {
  signAccessToken, issueRefreshToken, findRefreshToken, markUsed,
  revokeFamily, revokeAllForUser,
} from './tokenService.js';
import { UnauthenticatedError, ForbiddenError, DomainError, NotFoundError } from '../../utils/errors.js';
import logger from '../../config/logger.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;

/**
 * Login.
 *
 * Every failure path returns the same message and the same timing shape. An
 * error that distinguishes "no such user" from "wrong password" is a free
 * account-enumeration oracle, and one that says "this account is locked"
 * confirms the address exists.
 */
export async function login({ email, password, ip, userAgent }) {
  const genericFailure = () => new UnauthenticatedError('Invalid email or password', 'INVALID_CREDENTIALS');

  const user = await userRepository.findForAuthentication(email);

  if (!user) {
    // Equalize timing against the bcrypt comparison below.
    await hashPassword(`${password}-nonexistent`);
    throw genericFailure();
  }

  if (user.isLocked()) {
    await writeAudit({
      action: 'LOGIN_BLOCKED_LOCKED', module: 'AUTH', recordId: user._id,
      recordLabel: user.email, severity: 'WARNING', tenantId: user.tenantId,
    });
    throw genericFailure();
  }

  const valid = await user.verifyPassword(password);

  if (!valid) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLoginAttempts = 0;
      await writeAudit({
        action: 'ACCOUNT_LOCKED', module: 'AUTH', recordId: user._id,
        recordLabel: user.email, severity: 'WARNING', tenantId: user.tenantId,
        metadata: { lockMinutes: LOCK_MINUTES },
      });
    }
    await user.save();
    throw genericFailure();
  }

  if (user.status !== 'ACTIVE') {
    await writeAudit({
      action: 'LOGIN_BLOCKED_STATUS', module: 'AUTH', recordId: user._id,
      recordLabel: user.email, severity: 'WARNING', tenantId: user.tenantId,
      metadata: { status: user.status },
    });
    throw new ForbiddenError('This account is not active. Contact your administrator.', 'ACCOUNT_INACTIVE');
  }

  if (!user.role || user.role.status !== 'ACTIVE') {
    throw new ForbiddenError('Your role has been disabled. Contact your administrator.', 'ROLE_DISABLED');
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date();
  await user.save();

  const actor = buildActor(user, user.role);
  const accessToken = signAccessToken(actor, user.tokenVersion);
  const refresh = await issueRefreshToken(user, { ip, userAgent });

  await writeAudit({
    action: 'LOGIN_SUCCESS', module: 'AUTH', recordId: user._id,
    recordLabel: user.email, severity: 'INFO', tenantId: user.tenantId,
  });

  return { user, actor, accessToken, refresh };
}

/**
 * Refresh with rotation and reuse detection.
 *
 * Presenting a token that has already been exchanged means it was captured:
 * the legitimate holder rotated it, so whoever holds this copy should not.
 * The entire family is revoked and tokenVersion is bumped, which invalidates
 * every outstanding access token for that user within seconds.
 */
export async function refresh({ rawToken, ip, userAgent }) {
  const record = await findRefreshToken(rawToken);

  if (!record) throw new UnauthenticatedError('Session expired. Please sign in again.', 'REFRESH_INVALID');

  if (record.revokedAt) {
    throw new UnauthenticatedError('Session expired. Please sign in again.', 'REFRESH_REVOKED');
  }

  if (record.usedAt) {
    await revokeFamily(record.familyId, 'TOKEN_REUSE_DETECTED');
    await User.updateOne({ _id: record.user }, { $inc: { tokenVersion: 1 } });
    await writeAudit({
      action: 'SECURITY_TOKEN_REUSE', module: 'AUTH', recordId: record.user,
      severity: 'CRITICAL', tenantId: record.tenantId,
      metadata: { familyId: record.familyId, ip },
    });
    logger.error({ user: String(record.user), familyId: record.familyId }, 'Refresh token reuse detected');
    throw new UnauthenticatedError('Session invalidated for security reasons. Please sign in again.', 'TOKEN_REUSE');
  }

  if (record.expiresAt <= new Date()) {
    throw new UnauthenticatedError('Session expired. Please sign in again.', 'REFRESH_EXPIRED');
  }

  const user = await User.findOne({ _id: record.user, deletedAt: null }).populate('role');
  if (!user || user.status !== 'ACTIVE' || !user.role || user.role.status !== 'ACTIVE') {
    await revokeFamily(record.familyId, 'USER_INACTIVE');
    throw new UnauthenticatedError('Session is no longer valid', 'SESSION_INVALID');
  }

  const next = await issueRefreshToken(user, { familyId: record.familyId, ip, userAgent });
  await markUsed(record, next.raw);

  const actor = buildActor(user, user.role);
  const accessToken = signAccessToken(actor, user.tokenVersion);

  return { user, actor, accessToken, refresh: next };
}

export async function logout({ rawToken }) {
  const record = await findRefreshToken(rawToken);
  if (record && !record.revokedAt) {
    record.revokedAt = new Date();
    record.revokedReason = 'USER_LOGOUT';
    await record.save();
    await writeAudit({
      action: 'LOGOUT', module: 'AUTH', recordId: record.user,
      severity: 'INFO', tenantId: record.tenantId,
    });
  }
  return { success: true };
}

export async function logoutAll({ userId, tenantId }) {
  await revokeAllForUser(userId, 'USER_LOGOUT_ALL');
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await writeAudit({ action: 'LOGOUT_ALL', module: 'AUTH', recordId: userId, severity: 'NOTICE', tenantId });
  return { success: true };
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await userRepository.findByIdWithPassword(userId);
  if (!user) throw new NotFoundError('User not found');

  const valid = await user.verifyPassword(currentPassword);
  if (!valid) throw new UnauthenticatedError('Current password is incorrect', 'INVALID_CREDENTIALS');

  if (await user.verifyPassword(newPassword)) {
    throw new DomainError('The new password must be different from the current one', 'PASSWORD_UNCHANGED');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  user.tokenVersion += 1; // signs out every other session
  await user.save();

  await revokeAllForUser(user._id, 'PASSWORD_CHANGED');
  await writeAudit({
    action: 'PASSWORD_CHANGED', module: 'AUTH', recordId: user._id,
    recordLabel: user.email, severity: 'NOTICE', tenantId: user.tenantId,
  });

  return { success: true };
}

/**
 * Password reset request.
 *
 * Always reports success, whether or not the address exists — the response is
 * otherwise an account-enumeration oracle. The raw token is returned to the
 * caller only so that Phase 10 can hand it to the mailer; it is never put in
 * an API response.
 */
export async function requestPasswordReset({ email }) {
  const user = await userRepository.findByEmailForReset(email);
  if (!user || user.status !== 'ACTIVE') return { delivered: false, token: null };

  const raw = crypto.randomBytes(32).toString('base64url');
  user.passwordResetTokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
  await user.save();

  await writeAudit({
    action: 'PASSWORD_RESET_REQUESTED', module: 'AUTH', recordId: user._id,
    recordLabel: user.email, severity: 'NOTICE', tenantId: user.tenantId,
  });

  return { delivered: true, token: raw, user };
}

export async function resetPassword({ token, newPassword }) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await userRepository.findByResetToken(tokenHash);

  if (!user) throw new DomainError('This reset link is invalid or has expired', 'RESET_TOKEN_INVALID');

  user.passwordHash = await hashPassword(newPassword);
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.tokenVersion += 1;
  await user.save();

  await revokeAllForUser(user._id, 'PASSWORD_RESET');
  await writeAudit({
    action: 'PASSWORD_RESET_COMPLETED', module: 'AUTH', recordId: user._id,
    recordLabel: user.email, severity: 'NOTICE', tenantId: user.tenantId,
  });

  return { success: true };
}

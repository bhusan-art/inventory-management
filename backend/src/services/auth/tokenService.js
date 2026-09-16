import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import { RefreshToken, hashToken, generateRawToken } from '../../models/RefreshToken.js';
import { UnauthenticatedError } from '../../utils/errors.js';
import { randomUUID } from 'node:crypto';

const KIOSK_TTL_DAYS = 30;

/**
 * Access tokens carry a snapshot of the actor's permissions so the common path
 * needs no database round trip. `tokenVersion` is what keeps that snapshot
 * honest: it is compared against the user record on every request, so a role
 * change invalidates the snapshot immediately rather than in 15 minutes.
 */
export function signAccessToken(actor, tokenVersion) {
  return jwt.sign(
    {
      sub: actor.id,
      tid: actor.tenantId,
      rid: actor.roleId,
      rc: actor.roleCode,
      perms: [...actor.permissions],
      tv: tokenVersion,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL, issuer: 'ims', audience: 'ims-api' },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'ims', audience: 'ims-api' });
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw new UnauthenticatedError(
      code === 'TOKEN_EXPIRED' ? 'Your session has expired' : 'Invalid authentication token',
      code,
    );
  }
}

function ttlDays(sessionProfile) {
  return sessionProfile === 'KIOSK' ? KIOSK_TTL_DAYS : env.JWT_REFRESH_TTL_DAYS;
}

/** Issues a refresh token, optionally continuing an existing family. */
export async function issueRefreshToken(user, { familyId, ip, userAgent, session } = {}) {
  const raw = generateRawToken();
  const days = ttlDays(user.sessionProfile);

  const doc = {
    tenantId: user.tenantId,
    user: user._id,
    tokenHash: hashToken(raw),
    familyId: familyId ?? randomUUID(),
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    ip,
    userAgent,
    sessionProfile: user.sessionProfile,
  };

  const created = await RefreshToken.create(session ? [doc] : doc, session ? { session } : undefined);
  const record = Array.isArray(created) ? created[0] : created;
  return { raw, record, expiresAt: record.expiresAt };
}

export async function findRefreshToken(raw) {
  if (!raw) return null;
  return RefreshToken.findOne({ tokenHash: hashToken(raw) });
}

export async function markUsed(record, replacementRaw) {
  record.usedAt = new Date();
  record.replacedBy = hashToken(replacementRaw);
  await record.save();
}

export async function revokeFamily(familyId, reason) {
  await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeAllForUser(userId, reason) {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

/** Cookie options. HttpOnly and path-scoped so the token is never readable by JS. */
export function refreshCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  };
}

export const REFRESH_COOKIE = 'ims_rt';

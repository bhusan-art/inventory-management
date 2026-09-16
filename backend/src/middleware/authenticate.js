import { verifyAccessToken } from '../services/auth/tokenService.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { buildActor } from '../services/shared/permissionResolver.js';
import { setActor } from './requestContext.js';
import { UnauthenticatedError, ForbiddenError } from '../utils/errors.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * Short-lived cache of (userId → tokenVersion, status).
 *
 * The access token carries a permission snapshot, so the common path needs no
 * database read. But a snapshot that is never re-checked means a demoted or
 * deactivated user keeps their access until the token expires. The compromise:
 * verify `tokenVersion` against the database, and cache that check for a few
 * seconds so a burst of requests costs one read rather than fifty.
 *
 * Process-local by design. With several API containers each keeps its own, and
 * the worst case is a revocation taking CACHE_TTL_MS longer to land on one of
 * them — seconds, not the token lifetime.
 */
const CACHE_TTL_MS = 5_000;
const versionCache = new Map();

function cacheGet(userId) {
  const hit = versionCache.get(userId);
  if (!hit || hit.expires < Date.now()) {
    versionCache.delete(userId);
    return null;
  }
  return hit.value;
}

function cacheSet(userId, value) {
  versionCache.set(userId, { value, expires: Date.now() + CACHE_TTL_MS });
}

export function clearAuthCache() {
  versionCache.clear();
}

function extractToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !token) return null;
  return token.trim();
}

export const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw new UnauthenticatedError('Authentication required', 'TOKEN_MISSING');

  const payload = verifyAccessToken(token);

  let snapshot = cacheGet(payload.sub);
  if (!snapshot) {
    const user = await User.findOne({ _id: payload.sub, deletedAt: null })
      .select('tokenVersion status tenantId fullName email role permissionGrants permissionDenies scope mustChangePassword');
    if (!user) throw new UnauthenticatedError('Session is no longer valid', 'USER_NOT_FOUND');
    snapshot = {
      tokenVersion: user.tokenVersion,
      status: user.status,
      user: user.toObject(),
    };
    cacheSet(payload.sub, snapshot);
  }

  if (snapshot.status !== 'ACTIVE') {
    throw new ForbiddenError('This account is not active', 'ACCOUNT_INACTIVE');
  }

  // The snapshot in the token is stale — role, permissions, scope, status or
  // password changed since it was issued.
  if (snapshot.tokenVersion !== payload.tv) {
    throw new UnauthenticatedError(
      'Your access has changed. Please sign in again.',
      'TOKEN_STALE',
    );
  }

  if (String(snapshot.user.tenantId) !== payload.tid) {
    throw new UnauthenticatedError('Session is no longer valid', 'TENANT_MISMATCH');
  }

  // Permissions come from the token payload on the fast path. They were
  // resolved at issue time and tokenVersion guarantees they are still current.
  const actor = buildActor(snapshot.user, {
    _id: payload.rid,
    code: payload.rc,
    permissions: payload.perms,
    rank: 0,
  });
  // Rank is not carried in the token (it changes only with the role, which
  // bumps tokenVersion), so fetch it when a handler actually needs it.
  actor.loadRank = async () => {
    const role = await Role.findById(payload.rid).select('rank');
    actor.rank = role?.rank ?? 0;
    return actor.rank;
  };

  req.actor = actor;
  setActor(actor);
  if (req.context) req.context.actor = actor;

  return next();
});

export default authenticate;

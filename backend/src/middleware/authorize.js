import { assertKnownPermission } from '../constants/permissions.js';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';

/**
 * Route-level permission gate.
 *
 * `assertKnownPermission` runs at module load, not per request, so a typo in a
 * route definition crashes the process at boot instead of producing a
 * permission nobody holds (or, if a check were ever inverted, one everybody
 * holds).
 */
export function requirePermission(...codes) {
  codes.forEach(assertKnownPermission);

  return function permissionGate(req, res, next) {
    if (!req.actor) return next(new UnauthenticatedError());

    const missing = codes.filter((c) => !req.actor.permissions.has(c));
    if (missing.length > 0) {
      return next(
        new ForbiddenError(
          'You do not have permission to perform this action',
          'PERMISSION_DENIED',
          missing.map((c) => ({ code: 'PERMISSION_DENIED', permission: c })),
        ),
      );
    }
    return next();
  };
}

/** Passes when the actor holds at least one of the listed permissions. */
export function requireAnyPermission(...codes) {
  codes.forEach(assertKnownPermission);

  return function anyPermissionGate(req, res, next) {
    if (!req.actor) return next(new UnauthenticatedError());
    if (codes.some((c) => req.actor.permissions.has(c))) return next();
    return next(
      new ForbiddenError('You do not have permission to perform this action', 'PERMISSION_DENIED'),
    );
  };
}

export default requirePermission;

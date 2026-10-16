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

  function permissionGate(req, res, next) {
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
  }

  /**
   * The codes, readable from outside.
   *
   * The OpenAPI generator walks the live router and needs to say which
   * permission each route demands. A closure's captured values cannot be
   * recovered from its source, and a second hand-maintained list would drift
   * from the routes it claims to describe — so the gate carries its own answer.
   */
  permissionGate.requiredPermissions = Object.freeze([...codes]);

  return permissionGate;
}

export default requirePermission;

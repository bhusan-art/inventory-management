import { usePermissions } from '../hooks/usePermission.js';

/**
 * Hides a subtree the actor has no permission for.
 *
 * Presentation only — see usePermission.js. The server has already decided;
 * this exists so users are not shown controls that would fail.
 */
export default function PermissionGuard({ permission, anyOf, allOf, fallback = null, children }) {
  const permissions = usePermissions();

  let allowed = true;
  if (permission) allowed = permissions.has(permission);
  if (anyOf) allowed = allowed && anyOf.some((c) => permissions.has(c));
  if (allOf) allowed = allowed && allOf.every((c) => permissions.has(c));

  return allowed ? children : fallback;
}

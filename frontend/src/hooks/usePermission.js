import { useSelector } from 'react-redux';

/**
 * Permission hooks.
 *
 * THESE ARE PRESENTATION, NOT SECURITY. Everything they gate is already
 * enforced on the server; hiding a button the API would reject anyway is a
 * courtesy to the user, not a control. Anyone editing this file should assume
 * an attacker has already bypassed it.
 */
export function usePermissions() {
  const permissions = useSelector((s) => s.auth.permissions);
  return new Set(permissions);
}

export function usePermission(code) {
  const permissions = usePermissions();
  return permissions.has(code);
}

export function useCanAny(...codes) {
  const permissions = usePermissions();
  return codes.some((c) => permissions.has(c));
}

export function useCanAll(...codes) {
  const permissions = usePermissions();
  return codes.every((c) => permissions.has(c));
}

export function useSession() {
  return useSelector((s) => s.auth.session);
}

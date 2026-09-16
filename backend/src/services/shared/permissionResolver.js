import { isKnownPermission } from '../../constants/permissions.js';

/**
 * Effective permissions = role ∪ grants − denies.
 *
 * Denies win unconditionally, including over the role. That ordering is what
 * lets you keep one Sales user off exports without inventing a
 * "Sales (no export)" role, and it fails closed: an ambiguous configuration
 * removes access rather than granting it.
 *
 * Returns a Set — every caller does membership tests, never iteration order.
 */
export function resolveEffectivePermissions({ rolePermissions = [], grants = [], denies = [] }) {
  const effective = new Set();

  for (const code of rolePermissions) if (isKnownPermission(code)) effective.add(code);
  for (const code of grants) if (isKnownPermission(code)) effective.add(code);
  for (const code of denies) effective.delete(code);

  return effective;
}

/** Builds the actor object carried on req.context for the rest of the request. */
export function buildActor(user, role) {
  const permissions = resolveEffectivePermissions({
    rolePermissions: role?.permissions ?? [],
    grants: user.permissionGrants ?? [],
    denies: user.permissionDenies ?? [],
  });

  return {
    id: String(user._id),
    tenantId: String(user.tenantId),
    fullName: user.fullName,
    email: user.email,
    roleId: role ? String(role._id) : null,
    roleCode: role?.code ?? null,
    roleName: role?.name ?? null,
    rank: role?.rank ?? 0,
    permissions,
    warehouseIds: (user.scope?.warehouseIds ?? []).map(String),
    /** Empty scope means every warehouse in the tenant. */
    hasGlobalWarehouseScope: (user.scope?.warehouseIds ?? []).length === 0,
    can: (code) => permissions.has(code),
    canAll: (...codes) => codes.every((c) => permissions.has(c)),
    canAny: (...codes) => codes.some((c) => permissions.has(c)),
  };
}

export default resolveEffectivePermissions;

import { serialize, serializeMany } from './serialize.js';

const MODEL = 'User';

/**
 * Explicit allowlist. Returning the raw document would ship `passwordHash`,
 * `tokenVersion` and `failedLoginAttempts` the moment someone adds a field —
 * an allowlist fails safe when the schema grows, a denylist does not.
 */
const mapper = (u) => {
  const dto = {
    id: String(u._id),
    fullName: u.fullName,
    email: u.email,
    department: u.department ?? null,
    status: u.status,
    sessionProfile: u.sessionProfile,
    role: u.role && typeof u.role === 'object'
      ? { id: String(u.role._id), code: u.role.code, name: u.role.name, rank: u.role.rank }
      : u.role ? String(u.role) : null,
    permissionGrants: u.permissionGrants ?? [],
    permissionDenies: u.permissionDenies ?? [],
    scope: { warehouseIds: (u.scope?.warehouseIds ?? []).map(String) },
    mustChangePassword: Boolean(u.mustChangePassword),
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
  // Present only when the actor holds VIEW_CONTACT_DETAILS; stripRestricted
  // has already removed it otherwise.
  if ('phone' in u) dto.phone = u.phone ?? null;
  return dto;
};

export const serializeUser = (doc, permissions) => serialize(doc, { modelName: MODEL, mapper, permissions });
export const serializeUsers = (docs, permissions) => serializeMany(docs, { modelName: MODEL, mapper, permissions });

/** The /auth/me payload: identity plus the permission set the UI guards on. */
export function serializeSession(actor, user) {
  return {
    id: actor.id,
    fullName: actor.fullName,
    email: actor.email,
    role: { id: actor.roleId, code: actor.roleCode, name: actor.roleName, rank: actor.rank },
    permissions: [...actor.permissions].sort(),
    scope: {
      warehouseIds: actor.warehouseIds,
      hasGlobalWarehouseScope: actor.hasGlobalWarehouseScope,
    },
    mustChangePassword: Boolean(user?.mustChangePassword),
    tenantId: actor.tenantId,
  };
}

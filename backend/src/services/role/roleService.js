import { Role } from '../../models/Role.js';
import { User } from '../../models/User.js';
import { roleRepository } from '../../repositories/role.repository.js';
import { writeAudit, diff } from '../shared/auditService.js';
import { clearAuthCache } from '../../middleware/authenticate.js';
import { revokeAllForUser } from '../auth/tokenService.js';
import { resolveEffectivePermissions } from '../shared/permissionResolver.js';
import { NotFoundError, ForbiddenError, ConflictError, DomainError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

async function assertRankBelowActor(actor, rank, message) {
  await actor.loadRank?.();
  if (rank >= actor.rank && !actor.can('MANAGE_SUPER_ADMIN')) {
    throw new ForbiddenError(message, 'PRIVILEGE_ESCALATION_BLOCKED');
  }
}

function assertPermissionsWithinActor(actor, permissions = []) {
  const beyond = permissions.filter((c) => !actor.permissions.has(c));
  if (beyond.length > 0) {
    throw new ForbiddenError(
      'A role cannot be given permissions you do not hold yourself',
      'PRIVILEGE_ESCALATION_BLOCKED',
      beyond.map((c) => ({ code: 'PERMISSION_NOT_HELD', permission: c })),
    );
  }
}

export async function listRoles(actor, query) {
  const filter = {};
  if (query.search) filter.name = { $regex: query.search, $options: 'i' };
  if (query.status) filter.status = query.status;

  return roleRepository.paginate(filter, {
    tenantId: actor.tenantId,
    permissions: actor.permissions,
    page: query.page,
    limit: query.limit,
    sort: parseSort(query.sort, { rank: -1 }),
  });
}

export async function getRole(actor, id) {
  const role = await roleRepository.findById(id, { tenantId: actor.tenantId });
  if (!role) throw new NotFoundError('Role not found');
  return role;
}

export async function createRole(actor, payload) {
  await assertRankBelowActor(actor, payload.rank, 'You cannot create a role at or above your own level');
  assertPermissionsWithinActor(actor, payload.permissions);

  const existing = await Role.findOne({ tenantId: actor.tenantId, code: payload.code, deletedAt: null });
  if (existing) throw new ConflictError('A role with this code already exists', 'DUPLICATE_ROLE_CODE');

  const role = await Role.create({
    tenantId: actor.tenantId,
    ...payload,
    isSystem: false,
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'ROLE_CREATED', module: 'Role', recordId: role._id, recordLabel: role.code,
    severity: 'CRITICAL', tenantId: actor.tenantId,
    metadata: { permissionCount: role.permissions.length },
  });

  return role;
}

export async function updateRole(actor, id, payload) {
  const role = await Role.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!role) throw new NotFoundError('Role not found');

  await assertRankBelowActor(actor, role.rank, 'You cannot modify a role at or above your own level');

  /**
   * System roles keep their code and rank. Renaming or re-ranking Super Admin
   * is the single change that could lock every administrator out of the system
   * with no way back in short of a database edit.
   */
  if (role.isSystem) {
    if (payload.rank !== undefined && payload.rank !== role.rank) {
      throw new DomainError('The rank of a system role cannot be changed', 'SYSTEM_ROLE_PROTECTED');
    }
    if (payload.status === 'DISABLED' && role.code === 'SUPER_ADMIN') {
      throw new DomainError('The Super Admin role cannot be disabled', 'SYSTEM_ROLE_PROTECTED');
    }
  }

  if (payload.permissions) {
    assertPermissionsWithinActor(actor, payload.permissions);
    if (role.code === 'SUPER_ADMIN') {
      throw new DomainError('Super Admin permissions cannot be narrowed', 'SYSTEM_ROLE_PROTECTED');
    }
  }

  if (payload.rank !== undefined && payload.rank !== role.rank) {
    await assertRankBelowActor(actor, payload.rank, 'You cannot raise a role to or above your own level');
  }

  const before = role.toObject();
  Object.assign(role, payload);
  role.updatedBy = actor.id;
  await role.save();

  /**
   * A role's permissions changing alters the authorization of every user
   * holding it. Their access tokens carry a now-stale permission snapshot, so
   * bump each holder's tokenVersion — the middleware rejects the stale tokens
   * on the next request.
   */
  const authorizationChanged = Boolean(payload.permissions) || payload.status === 'DISABLED';
  if (authorizationChanged) {
    const holders = await User.find({ role: role._id, deletedAt: null }).select('_id');
    await User.updateMany({ role: role._id, deletedAt: null }, { $inc: { tokenVersion: 1 } });
    await Promise.all(holders.map((u) => revokeAllForUser(u._id, 'ROLE_PERMISSIONS_CHANGED')));
    clearAuthCache();
  }

  await writeAudit({
    action: 'ROLE_UPDATED', module: 'Role', recordId: role._id, recordLabel: role.code,
    severity: 'CRITICAL', tenantId: actor.tenantId,
    changes: diff(before, role.toObject(), ['name', 'description', 'rank', 'permissions', 'status']),
  });

  return role;
}

export async function deleteRole(actor, id) {
  const role = await Role.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!role) throw new NotFoundError('Role not found');

  if (role.isSystem) {
    throw new DomainError('System roles cannot be deleted', 'SYSTEM_ROLE_PROTECTED');
  }

  await assertRankBelowActor(actor, role.rank, 'You cannot delete a role at or above your own level');

  // Blocking rather than cascading: orphaning users into a roleless state
  // would leave them unable to log in with no obvious cause.
  const holders = await User.countDocuments({ role: role._id, deletedAt: null });
  if (holders > 0) {
    throw new ConflictError(
      `This role is assigned to ${holders} user${holders === 1 ? '' : 's'}. Reassign them first.`,
      'REFERENCE_IN_USE',
      [{ code: 'REFERENCE_IN_USE', field: 'role', count: holders }],
    );
  }

  await roleRepository.softDeleteById(id, { tenantId: actor.tenantId, actorId: actor.id });

  await writeAudit({
    action: 'ROLE_DELETED', module: 'Role', recordId: role._id, recordLabel: role.code,
    severity: 'CRITICAL', tenantId: actor.tenantId,
  });

  return { success: true };
}

/**
 * Preview of what a user would actually end up with, after grants and denies
 * are applied to the role. The Roles screen shows this because "role has 40
 * permissions" is not the question an administrator is asking — "what can this
 * person do" is.
 */
export async function previewEffectivePermissions(actor, userId) {
  const user = await User.findOne({ _id: userId, tenantId: actor.tenantId, deletedAt: null }).populate('role');
  if (!user) throw new NotFoundError('User not found');

  const effective = resolveEffectivePermissions({
    rolePermissions: user.role?.permissions ?? [],
    grants: user.permissionGrants,
    denies: user.permissionDenies,
  });

  return {
    user: { id: String(user._id), fullName: user.fullName, email: user.email },
    role: user.role ? { code: user.role.code, name: user.role.name, permissions: user.role.permissions } : null,
    grants: user.permissionGrants,
    denies: user.permissionDenies,
    effective: [...effective].sort(),
  };
}

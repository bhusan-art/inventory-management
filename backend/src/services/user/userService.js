import crypto from 'node:crypto';
import { User, hashPassword } from '../../models/User.js';
import { Role } from '../../models/Role.js';
import { userRepository } from '../../repositories/user.repository.js';
import { writeAudit, diff } from '../shared/auditService.js';
import { revokeAllForUser } from '../auth/tokenService.js';
import { clearAuthCache } from '../../middleware/authenticate.js';
import { NotFoundError, ForbiddenError, ConflictError, DomainError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

/**
 * Privilege ceiling.
 *
 * Two rules, and they are the difference between an RBAC system and a
 * decoration:
 *
 *   1. You may not assign a role whose rank is >= your own. Otherwise an Admin
 *      creates a Super Admin and the distinction is meaningless.
 *   2. You may not grant a permission you do not hold yourself. Otherwise an
 *      Admin grants MANAGE_SUPER_ADMIN to a Viewer and then logs in as them.
 */
async function assertCanAssignRole(actor, roleId, tenantId) {
  const role = await Role.findOne({ _id: roleId, tenantId, deletedAt: null });
  if (!role) throw new NotFoundError('Role not found');
  if (role.status !== 'ACTIVE') throw new DomainError('That role is disabled', 'ROLE_DISABLED');

  await actor.loadRank?.();
  if (role.rank >= actor.rank && !actor.can('MANAGE_SUPER_ADMIN')) {
    throw new ForbiddenError(
      'You cannot assign a role at or above your own level',
      'PRIVILEGE_ESCALATION_BLOCKED',
    );
  }
  return role;
}

function assertCanGrant(actor, grants = []) {
  const beyond = grants.filter((c) => !actor.permissions.has(c));
  if (beyond.length > 0) {
    throw new ForbiddenError(
      'You cannot grant permissions you do not hold yourself',
      'PRIVILEGE_ESCALATION_BLOCKED',
      beyond.map((c) => ({ code: 'PERMISSION_NOT_HELD', permission: c })),
    );
  }
}

export async function listUsers(actor, query) {
  const filter = {};
  if (query.search) {
    filter.$or = [
      { fullName: { $regex: query.search, $options: 'i' } },
      { email: { $regex: query.search, $options: 'i' } },
    ];
  }
  if (query.status) filter.status = query.status;

  return userRepository.paginate(filter, {
    tenantId: actor.tenantId,
    permissions: actor.permissions,
    page: query.page,
    limit: query.limit,
    sort: parseSort(query.sort),
  }).then(async (result) => {
    await User.populate(result.items, { path: 'role', select: 'code name rank' });
    return result;
  });
}

export async function getUser(actor, id) {
  const user = await userRepository.findWithRole(id, {
    tenantId: actor.tenantId,
    permissions: actor.permissions,
  });
  if (!user) throw new NotFoundError('User not found');
  return user;
}

export async function createUser(actor, payload) {
  await assertCanAssignRole(actor, payload.role, actor.tenantId);
  assertCanGrant(actor, payload.permissionGrants);

  const existing = await User.findOne({
    tenantId: actor.tenantId,
    email: payload.email,
    deletedAt: null,
  });
  if (existing) throw new ConflictError('A user with this email already exists', 'DUPLICATE_EMAIL');

  // A generated password is preferable to a default one: nobody can log in as
  // a new user without the administrator explicitly passing the value on.
  const temporaryPassword = payload.password ?? `${crypto.randomBytes(9).toString('base64url')}A1`;

  const user = await User.create({
    tenantId: actor.tenantId,
    fullName: payload.fullName,
    email: payload.email,
    phone: payload.phone,
    passwordHash: await hashPassword(temporaryPassword),
    role: payload.role,
    department: payload.department,
    sessionProfile: payload.sessionProfile,
    permissionGrants: payload.permissionGrants,
    permissionDenies: payload.permissionDenies,
    scope: payload.scope,
    mustChangePassword: true,
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'USER_CREATED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: 'NOTICE', tenantId: actor.tenantId,
    metadata: { role: String(payload.role) },
  });

  await user.populate('role');
  // Returned once, never stored, never logged. The administrator delivers it
  // out of band and the user must change it at first login.
  return { user, temporaryPassword: payload.password ? null : temporaryPassword };
}

export async function updateUser(actor, id, payload) {
  const user = await User.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!user) throw new NotFoundError('User not found');

  const before = user.toObject();
  let authorizationChanged = false;

  if (payload.role && String(payload.role) !== String(user.role)) {
    await assertCanAssignRole(actor, payload.role, actor.tenantId);
    user.role = payload.role;
    authorizationChanged = true;
  }

  for (const field of ['fullName', 'phone', 'department', 'sessionProfile']) {
    if (payload[field] !== undefined) user[field] = payload[field];
  }

  user.updatedBy = actor.id;
  if (authorizationChanged) user.tokenVersion += 1;
  await user.save();

  if (authorizationChanged) {
    clearAuthCache();
    await revokeAllForUser(user._id, 'ROLE_CHANGED');
  }

  await writeAudit({
    action: 'USER_UPDATED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: authorizationChanged ? 'CRITICAL' : 'NOTICE', tenantId: actor.tenantId,
    changes: diff(before, user.toObject(), ['fullName', 'phone', 'department', 'sessionProfile', 'role']),
  });

  await user.populate('role');
  return user;
}

export async function updateStatus(actor, id, status) {
  if (String(id) === String(actor.id)) {
    throw new DomainError('You cannot change your own account status', 'SELF_MODIFICATION_BLOCKED');
  }

  const user = await User.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!user) throw new NotFoundError('User not found');

  const previous = user.status;
  user.status = status;
  user.updatedBy = actor.id;
  user.tokenVersion += 1; // deactivation must land immediately
  if (status === 'ACTIVE') {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }
  await user.save();

  clearAuthCache();
  if (status !== 'ACTIVE') await revokeAllForUser(user._id, `STATUS_${status}`);

  await writeAudit({
    action: 'USER_STATUS_CHANGED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: 'CRITICAL', tenantId: actor.tenantId,
    changes: [{ field: 'status', before: previous, after: status }],
  });

  await user.populate('role');
  return user;
}

export async function updatePermissions(actor, id, { permissionGrants, permissionDenies }) {
  assertCanGrant(actor, permissionGrants);

  const user = await User.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!user) throw new NotFoundError('User not found');

  const before = user.toObject();
  user.permissionGrants = permissionGrants;
  user.permissionDenies = permissionDenies;
  user.updatedBy = actor.id;
  user.tokenVersion += 1;
  await user.save();

  clearAuthCache();
  await revokeAllForUser(user._id, 'PERMISSIONS_CHANGED');

  await writeAudit({
    action: 'USER_PERMISSIONS_CHANGED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: 'CRITICAL', tenantId: actor.tenantId,
    changes: diff(before, user.toObject(), ['permissionGrants', 'permissionDenies']),
  });

  await user.populate('role');
  return user;
}

export async function updateScope(actor, id, warehouseIds) {
  const user = await User.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!user) throw new NotFoundError('User not found');

  const before = (user.scope?.warehouseIds ?? []).map(String);
  user.scope = { warehouseIds };
  user.updatedBy = actor.id;
  user.tokenVersion += 1;
  await user.save();

  clearAuthCache();

  await writeAudit({
    action: 'USER_SCOPE_CHANGED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: 'CRITICAL', tenantId: actor.tenantId,
    changes: [{ field: 'scope.warehouseIds', before, after: warehouseIds.map(String) }],
  });

  await user.populate('role');
  return user;
}

export async function resetUserPassword(actor, id) {
  const user = await User.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!user) throw new NotFoundError('User not found');

  const temporaryPassword = `${crypto.randomBytes(9).toString('base64url')}A1`;
  user.passwordHash = await hashPassword(temporaryPassword);
  user.mustChangePassword = true;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.tokenVersion += 1;
  user.updatedBy = actor.id;
  await user.save();

  clearAuthCache();
  await revokeAllForUser(user._id, 'ADMIN_PASSWORD_RESET');

  await writeAudit({
    action: 'USER_PASSWORD_RESET_BY_ADMIN', module: 'User', recordId: user._id,
    recordLabel: user.email, severity: 'CRITICAL', tenantId: actor.tenantId,
  });

  return { temporaryPassword };
}

export async function deleteUser(actor, id) {
  if (String(id) === String(actor.id)) {
    throw new DomainError('You cannot delete your own account', 'SELF_MODIFICATION_BLOCKED');
  }

  const user = await userRepository.softDeleteById(id, {
    tenantId: actor.tenantId,
    actorId: actor.id,
  });
  if (!user) throw new NotFoundError('User not found');

  user.tokenVersion += 1;
  await user.save();
  clearAuthCache();
  await revokeAllForUser(user._id, 'USER_DELETED');

  await writeAudit({
    action: 'USER_DELETED', module: 'User', recordId: user._id, recordLabel: user.email,
    severity: 'CRITICAL', tenantId: actor.tenantId,
  });

  return { success: true };
}

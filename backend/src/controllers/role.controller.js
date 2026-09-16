import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as roleService from '../services/role/roleService.js';
import { serializeRole, serializeRoles } from '../serializers/role.serializer.js';
import { PERMISSION_DEFINITIONS } from '../constants/permissions.js';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await roleService.listRoles(req.actor, req.query);
  return ok(res, { data: serializeRoles(items, req.actor.permissions), meta });
});

export const getById = asyncHandler(async (req, res) => {
  const role = await roleService.getRole(req.actor, req.params.id);
  return ok(res, { data: serializeRole(role, req.actor.permissions) });
});

export const create = asyncHandler(async (req, res) => {
  const role = await roleService.createRole(req.actor, req.body);
  return created(res, { message: 'Role created', data: serializeRole(role, req.actor.permissions) });
});

export const update = asyncHandler(async (req, res) => {
  const role = await roleService.updateRole(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Role updated', data: serializeRole(role, req.actor.permissions) });
});

export const remove = asyncHandler(async (req, res) => {
  await roleService.deleteRole(req.actor, req.params.id);
  return ok(res, { message: 'Role deleted' });
});

export const effectivePreview = asyncHandler(async (req, res) => {
  const preview = await roleService.previewEffectivePermissions(req.actor, req.params.userId);
  return ok(res, { data: preview });
});

/** The catalogue, grouped by module, for the role editor UI. */
export const listPermissions = asyncHandler(async (req, res) => {
  const grouped = PERMISSION_DEFINITIONS.reduce((acc, p) => {
    (acc[p.module] ??= []).push({ code: p.code, label: p.label, restricted: p.restricted });
    return acc;
  }, {});
  return ok(res, { data: { modules: grouped, total: PERMISSION_DEFINITIONS.length } });
});

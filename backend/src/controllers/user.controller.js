import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as userService from '../services/user/userService.js';
import { serializeUser, serializeUsers } from '../serializers/user.serializer.js';

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await userService.listUsers(req.actor, req.query);
  return ok(res, { data: serializeUsers(items, req.actor.permissions), meta });
});

export const getById = asyncHandler(async (req, res) => {
  const user = await userService.getUser(req.actor, req.params.id);
  return ok(res, { data: serializeUser(user, req.actor.permissions) });
});

export const create = asyncHandler(async (req, res) => {
  const { user, temporaryPassword } = await userService.createUser(req.actor, req.body);
  return created(res, {
    message: 'User created',
    data: {
      user: serializeUser(user, req.actor.permissions),
      // Shown once, to the creating administrator only, and never persisted in
      // readable form. They deliver it out of band.
      temporaryPassword,
    },
  });
});

export const update = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.actor, req.params.id, req.body);
  return ok(res, { message: 'User updated', data: serializeUser(user, req.actor.permissions) });
});

export const setStatus = asyncHandler(async (req, res) => {
  const user = await userService.updateStatus(req.actor, req.params.id, req.body.status);
  return ok(res, { message: 'Status updated', data: serializeUser(user, req.actor.permissions) });
});

export const setPermissions = asyncHandler(async (req, res) => {
  const user = await userService.updatePermissions(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Permissions updated', data: serializeUser(user, req.actor.permissions) });
});

export const setScope = asyncHandler(async (req, res) => {
  const user = await userService.updateScope(req.actor, req.params.id, req.body.warehouseIds);
  return ok(res, { message: 'Warehouse scope updated', data: serializeUser(user, req.actor.permissions) });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { temporaryPassword } = await userService.resetUserPassword(req.actor, req.params.id);
  return ok(res, { message: 'Password reset', data: { temporaryPassword } });
});

export const remove = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.actor, req.params.id);
  return ok(res, { message: 'User deleted' });
});

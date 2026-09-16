import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { serializeMaster, serializeMasterMany } from '../serializers/master.serializer.js';

/**
 * Controllers for master data are identical apart from which service they
 * call, so they are generated from it. A controller that does anything more
 * interesting than this is doing work that belongs in a service.
 */
export function createMasterController(service) {
  const { modelName } = service;

  return {
    list: asyncHandler(async (req, res) => {
      const { items, meta } = await service.list(req.actor, req.query);
      return ok(res, { data: serializeMasterMany(modelName, items, req.actor.permissions), meta });
    }),

    getById: asyncHandler(async (req, res) => {
      const doc = await service.getById(req.actor, req.params.id);
      return ok(res, { data: serializeMaster(modelName, doc, req.actor.permissions) });
    }),

    create: asyncHandler(async (req, res) => {
      const doc = await service.create(req.actor, req.body);
      return created(res, {
        message: `${modelName} created`,
        data: serializeMaster(modelName, doc, req.actor.permissions),
      });
    }),

    update: asyncHandler(async (req, res) => {
      const doc = await service.update(req.actor, req.params.id, req.body);
      return ok(res, {
        message: `${modelName} updated`,
        data: serializeMaster(modelName, doc, req.actor.permissions),
      });
    }),

    remove: asyncHandler(async (req, res) => {
      await service.remove(req.actor, req.params.id);
      return ok(res, { message: `${modelName} deleted` });
    }),
  };
}

export default createMasterController;

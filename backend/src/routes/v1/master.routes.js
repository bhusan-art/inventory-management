import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import queryGuard from '../../middleware/queryGuard.js';
import { createMasterController } from '../../controllers/master.controller.js';
import { listQuerySchema, idParamSchema } from '../../validators/common.schema.js';

/**
 * Builds a standard master-data router.
 *
 * Permissions are derived from the module name, so a route cannot accidentally
 * be mounted without one — `requirePermission` validates each code against the
 * catalogue at module load, which means a mistake here crashes at boot rather
 * than shipping an unguarded endpoint.
 */
export function createMasterRouter({ service, permissionModule, schemas, modelName }) {
  const router = Router();
  const controller = createMasterController(service);

  router.use(authenticate);

  router.get(
    '/',
    requirePermission(`VIEW_${permissionModule}`),
    queryGuard(modelName ?? service.modelName),
    validate({ query: listQuerySchema }),
    controller.list,
  );

  router.post(
    '/',
    requirePermission(`CREATE_${permissionModule}`),
    validate(schemas.create),
    controller.create,
  );

  router.get(
    '/:id',
    requirePermission(`VIEW_${permissionModule}`),
    validate({ params: idParamSchema }),
    controller.getById,
  );

  router.put(
    '/:id',
    requirePermission(`UPDATE_${permissionModule}`),
    validate(schemas.update),
    controller.update,
  );

  router.delete(
    '/:id',
    requirePermission(`DELETE_${permissionModule}`),
    validate({ params: z.object({ id: idParamSchema.shape.id }) }),
    controller.remove,
  );

  return { router, controller };
}

export default createMasterRouter;

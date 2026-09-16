import { Router } from 'express';
import * as controller from '../../controllers/user.controller.js';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import queryGuard from '../../middleware/queryGuard.js';
import { listQuerySchema, idParamSchema } from '../../validators/common.schema.js';
import {
  createUserSchema, updateUserSchema, updateStatusSchema,
  updatePermissionsSchema, updateScopeSchema,
} from '../../validators/user.schema.js';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

router.get(
  '/',
  requirePermission('VIEW_USER'),
  // Blocks ?sort=phone and ?filter[phone] for actors without
  // VIEW_CONTACT_DETAILS — hiding the field is not enough on its own.
  queryGuard('User'),
  validate({ query: listQuerySchema }),
  controller.list,
);

router.post('/', requirePermission('CREATE_USER'), validate(createUserSchema), controller.create);

router.get(
  '/:id',
  requirePermission('VIEW_USER'),
  validate({ params: idParamSchema }),
  controller.getById,
);

router.put('/:id', requirePermission('UPDATE_USER'), validate(updateUserSchema), controller.update);

router.patch(
  '/:id/status',
  requirePermission('UPDATE_USER'),
  validate(updateStatusSchema),
  controller.setStatus,
);

router.patch(
  '/:id/permissions',
  requirePermission('UPDATE_USER', 'UPDATE_ROLE'),
  validate(updatePermissionsSchema),
  controller.setPermissions,
);

router.patch(
  '/:id/scope',
  requirePermission('UPDATE_USER'),
  validate(updateScopeSchema),
  controller.setScope,
);

router.post(
  '/:id/reset-password',
  requirePermission('UPDATE_USER'),
  validate({ params: idParamSchema }),
  controller.resetPassword,
);

router.delete(
  '/:id',
  requirePermission('DELETE_USER'),
  validate({ params: z.object({ id: idParamSchema.shape.id }) }),
  controller.remove,
);

export default router;

import { Router } from 'express';
import * as controller from '../../controllers/role.controller.js';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import { listQuerySchema, idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { createRoleSchema, updateRoleSchema } from '../../validators/role.schema.js';
import { z } from 'zod';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission('VIEW_ROLE'), validate({ query: listQuerySchema }), controller.list);
router.post('/', requirePermission('CREATE_ROLE'), validate(createRoleSchema), controller.create);
router.get('/:id', requirePermission('VIEW_ROLE'), validate({ params: idParamSchema }), controller.getById);
router.put('/:id', requirePermission('UPDATE_ROLE'), validate(updateRoleSchema), controller.update);
router.delete('/:id', requirePermission('DELETE_ROLE'), validate({ params: idParamSchema }), controller.remove);

router.get(
  '/effective/:userId',
  requirePermission('VIEW_ROLE', 'VIEW_USER'),
  validate({ params: z.object({ userId: objectIdSchema }) }),
  controller.effectivePreview,
);

export default router;

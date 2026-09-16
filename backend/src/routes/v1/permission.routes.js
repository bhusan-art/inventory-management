import { Router } from 'express';
import * as controller from '../../controllers/role.controller.js';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('VIEW_ROLE'), controller.listPermissions);

export default router;

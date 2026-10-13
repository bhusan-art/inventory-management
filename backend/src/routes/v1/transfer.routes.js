import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/transfer.controller.js';
import { idParamSchema } from '../../validators/common.schema.js';
import { transferSchemas } from '../../validators/transfer.schema.js';

/**
 * Four steps, four separate permissions.
 *
 * Request, approve, dispatch and receive are usually different people in
 * different buildings, and the separation is the control: whoever loads the
 * truck should not be the person who confirms it arrived. Scope is enforced in
 * the service — dispatch needs the source warehouse, receipt the destination.
 */
export const transferRouter = Router();
transferRouter.use(authenticate);

transferRouter.get('/', requirePermission('VIEW_TRANSFER'),
  validate({ query: transferSchemas.list }), controller.list);
transferRouter.post('/', requirePermission('CREATE_TRANSFER'),
  validate(transferSchemas.create), controller.create);
transferRouter.get('/:id', requirePermission('VIEW_TRANSFER'),
  validate({ params: idParamSchema }), controller.getById);
transferRouter.post('/:id/approve', requirePermission('APPROVE_TRANSFER'),
  validate({ params: idParamSchema }), controller.approve);
transferRouter.post('/:id/dispatch', requirePermission('DISPATCH_TRANSFER'),
  validate(transferSchemas.dispatch), controller.dispatch);
transferRouter.post('/:id/receive', requirePermission('RECEIVE_TRANSFER'),
  validate(transferSchemas.receive), controller.receive);
transferRouter.post('/:id/cancel', requirePermission('UPDATE_TRANSFER'),
  validate(transferSchemas.cancel), controller.cancel);

export default transferRouter;

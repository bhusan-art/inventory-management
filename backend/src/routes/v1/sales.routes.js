import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/sales.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { salesOrderSchemas, dispatchSchemas } from '../../validators/sales.schema.js';

export const salesOrderRouter = Router();
salesOrderRouter.use(authenticate);

salesOrderRouter.get('/', requirePermission('VIEW_SALES_ORDER'),
  validate({ query: salesOrderSchemas.list }), controller.listOrders);
salesOrderRouter.post('/', requirePermission('CREATE_SALES_ORDER'),
  validate(salesOrderSchemas.create), controller.createOrder);
salesOrderRouter.get('/:id', requirePermission('VIEW_SALES_ORDER'),
  validate({ params: idParamSchema }), controller.getOrder);

/**
 * Confirming reserves stock, so it carries its own permission rather than
 * riding on UPDATE_SALES_ORDER: editing a draft is clerical, claiming units
 * out of available stock is not.
 */
salesOrderRouter.post('/:id/confirm', requirePermission('CONFIRM_SALES_ORDER'),
  validate(salesOrderSchemas.confirm), controller.confirmOrder);
salesOrderRouter.post('/:id/release', requirePermission('CONFIRM_SALES_ORDER'),
  validate(salesOrderSchemas.cancel), controller.releaseOrder);
salesOrderRouter.post('/:id/cancel', requirePermission('UPDATE_SALES_ORDER'),
  validate(salesOrderSchemas.cancel), controller.cancelOrder);

export const dispatchRouter = Router();
dispatchRouter.use(authenticate);

dispatchRouter.get('/', requirePermission('VIEW_DISPATCH_NOTE'),
  validate({ query: dispatchSchemas.list }), controller.listDispatches);
dispatchRouter.post('/', requirePermission('CREATE_DISPATCH'),
  validate(dispatchSchemas.create), controller.createDispatch);
dispatchRouter.get('/:id', requirePermission('VIEW_DISPATCH_NOTE'),
  validate({ params: idParamSchema }), controller.getDispatch);
dispatchRouter.post('/:id/deliver', requirePermission('CREATE_DISPATCH'),
  validate(dispatchSchemas.deliver), controller.markDelivered);
dispatchRouter.post('/:id/cancel', requirePermission('CANCEL_DISPATCH'),
  validate(dispatchSchemas.cancel), controller.cancelDispatch);

dispatchRouter.get('/customer/:customerId/assets',
  requirePermission('VIEW_CUSTOMER', 'VIEW_SERIAL'),
  validate({ params: z.object({ customerId: objectIdSchema }) }), controller.customerAssets);

export default salesOrderRouter;

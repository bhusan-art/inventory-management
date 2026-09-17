import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/purchase.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { poSchemas, grnSchemas, listPurchaseQuery } from '../../validators/purchase.schema.js';

export const purchaseOrderRouter = Router();
purchaseOrderRouter.use(authenticate);

purchaseOrderRouter.get('/', requirePermission('VIEW_PURCHASE_ORDER'),
  validate({ query: listPurchaseQuery }), controller.listPos);
purchaseOrderRouter.post('/', requirePermission('CREATE_PURCHASE_ORDER'),
  validate(poSchemas.create), controller.createPo);
purchaseOrderRouter.get('/:id', requirePermission('VIEW_PURCHASE_ORDER'),
  validate({ params: idParamSchema }), controller.getPo);
purchaseOrderRouter.put('/:id', requirePermission('UPDATE_PURCHASE_ORDER'),
  validate(poSchemas.update), controller.updatePo);
purchaseOrderRouter.post('/:id/approve', requirePermission('APPROVE_PURCHASE_ORDER'),
  validate({ params: idParamSchema }), controller.approvePo);
purchaseOrderRouter.post('/:id/cancel', requirePermission('UPDATE_PURCHASE_ORDER'),
  validate(poSchemas.close), controller.cancelPo);
purchaseOrderRouter.post('/:id/close-short', requirePermission('CLOSE_PURCHASE_ORDER'),
  validate(poSchemas.close), controller.shortClosePo);

export const grnRouter = Router();
grnRouter.use(authenticate);

grnRouter.get('/', requirePermission('VIEW_GRN'), validate({ query: listPurchaseQuery }), controller.listGrns);
grnRouter.post('/', requirePermission('CREATE_GRN'), validate(grnSchemas.create), controller.createGrn);
grnRouter.get('/:id', requirePermission('VIEW_GRN'), validate({ params: idParamSchema }), controller.getGrn);

// Posting is the irreversible moment, so it has its own permission — a
// Warehouse Operator holds POST_GRN but not CANCEL_GRN. Reversing posted stock
// history is not a receiving task.
grnRouter.post('/:id/post', requirePermission('POST_GRN'),
  validate({ params: idParamSchema }), controller.postGrn);
grnRouter.post('/:id/cancel', requirePermission('CANCEL_GRN'),
  validate(grnSchemas.cancel), controller.cancelGrn);

export const inventoryRouter = Router();
inventoryRouter.use(authenticate);

const inventoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  product: objectIdSchema.optional(),
  warehouse: objectIdSchema.optional(),
  inStock: z.coerce.boolean().optional(),
  transactionType: z.string().max(40).optional(),
  referenceId: objectIdSchema.optional(),
});

inventoryRouter.get('/', requirePermission('VIEW_INVENTORY'),
  validate({ query: inventoryQuery }), controller.listInventory);
inventoryRouter.get('/transactions', requirePermission('VIEW_INVENTORY'),
  validate({ query: inventoryQuery }), controller.listTransactions);
inventoryRouter.post('/reconcile', requirePermission('RECONCILE_INVENTORY'), controller.runReconciliation);

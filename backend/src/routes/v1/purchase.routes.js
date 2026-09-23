import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/purchase.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { poSchemas, grnSchemas, listPurchaseQuery } from '../../validators/purchase.schema.js';
import * as inventoryController from '../../controllers/inventory.controller.js';
import {
  adjustSchema, reclassifySchema, countSchemas, lowStockQuery,
} from '../../validators/inventory.schema.js';

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

// ---------------------------------------------------------------- Phase 4
inventoryRouter.get('/low-stock', requirePermission('VIEW_INVENTORY'),
  validate({ query: lowStockQuery }), inventoryController.lowStock);

inventoryRouter.post('/adjust', requirePermission('ADJUST_INVENTORY'),
  validate(adjustSchema), inventoryController.adjust);

inventoryRouter.post('/reclassify', requirePermission('ADJUST_INVENTORY'),
  validate(reclassifySchema), inventoryController.reclassify);

/**
 * Stock counts.
 *
 * Generating and recording are ADJUST_INVENTORY — routine warehouse work.
 * Completing writes every variance to the ledger at once, so it is gated on
 * ADJUST_INVENTORY_UNLIMITED: a count can legitimately post changes far beyond
 * the per-adjustment threshold, and that needs to be a deliberate decision by
 * someone who can be held to it.
 */
export const stockCountRouter = Router();
stockCountRouter.use(authenticate);

stockCountRouter.get('/', requirePermission('VIEW_INVENTORY'), inventoryController.listCounts);
stockCountRouter.post('/', requirePermission('ADJUST_INVENTORY'),
  validate(countSchemas.create), inventoryController.createCount);
stockCountRouter.get('/:id', requirePermission('VIEW_INVENTORY'),
  validate({ params: idParamSchema }), inventoryController.getCount);
stockCountRouter.patch('/:id/counts', requirePermission('ADJUST_INVENTORY'),
  validate(countSchemas.record), inventoryController.recordCounts);
stockCountRouter.post('/:id/complete', requirePermission('ADJUST_INVENTORY_UNLIMITED'),
  validate(countSchemas.complete), inventoryController.completeCount);
stockCountRouter.post('/:id/cancel', requirePermission('ADJUST_INVENTORY'),
  validate(countSchemas.cancel), inventoryController.cancelCount);

export const notificationRouter = Router();
notificationRouter.use(authenticate);

// No permission gate: notifications are already filtered to what the actor is
// addressed by, personally or through a permission they hold.
notificationRouter.get('/', inventoryController.listNotifications);
notificationRouter.patch('/:id/read', validate({ params: idParamSchema }), inventoryController.readNotification);
notificationRouter.post('/read-all', inventoryController.readAllNotifications);

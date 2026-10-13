import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/serial.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { serialSchemas } from '../../validators/serial.schema.js';

export const serialRouter = Router();
serialRouter.use(authenticate);

serialRouter.get('/', requirePermission('VIEW_SERIAL'),
  validate({ query: serialSchemas.list }), controller.list);

/**
 * Mounted before /:id so a scanned serial number is never mistaken for an id.
 * Anyone who can view serials can scan — the scan is how a warehouse asks
 * "what is this thing in my hand", and gating it tighter would make the
 * scanner useless to the people holding it.
 */
serialRouter.get('/scan/:serialNumber', requirePermission('VIEW_SERIAL'),
  validate(serialSchemas.scan), controller.scan);

serialRouter.post('/import', requirePermission('CREATE_SERIAL', 'ADJUST_INVENTORY_UNLIMITED'),
  validate(serialSchemas.import), controller.bulkImport);

serialRouter.get('/consistency/:productId', requirePermission('VIEW_INVENTORY'),
  validate({ params: z.object({ productId: objectIdSchema }) }), controller.consistencyCheck);

serialRouter.get('/labels', requirePermission('VIEW_SERIAL'),
  validate({ query: serialSchemas.labels }), controller.labels);

serialRouter.get('/:id/history', requirePermission('VIEW_SERIAL'),
  validate({ params: idParamSchema }), controller.history);
serialRouter.get('/:id/qrcode', requirePermission('VIEW_SERIAL'),
  validate({ params: idParamSchema }), controller.qrCode);
serialRouter.get('/:id/barcode', requirePermission('VIEW_SERIAL'),
  validate({ params: idParamSchema }), controller.barcode);
serialRouter.get('/:id/label', requirePermission('VIEW_SERIAL'),
  validate({ params: idParamSchema }), controller.labels);

serialRouter.patch('/:id', requirePermission('UPDATE_SERIAL'),
  validate(serialSchemas.attributes), controller.updateAttributes);

// Overriding a lifecycle by hand moves stock between buckets as a side effect,
// so it carries its own permission rather than riding on UPDATE_SERIAL.
serialRouter.patch('/:id/status', requirePermission('OVERRIDE_SERIAL_STATUS'),
  validate(serialSchemas.override), controller.overrideStatus);

export default serialRouter;

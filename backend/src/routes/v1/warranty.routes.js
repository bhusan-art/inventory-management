import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/warranty.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { warrantySchemas, serviceSchemas } from '../../validators/warranty.schema.js';

const serialParam = { params: z.object({ serialId: objectIdSchema }) };

export const warrantyRouter = Router();
warrantyRouter.use(authenticate);

warrantyRouter.get('/', requirePermission('VIEW_WARRANTY'),
  validate({ query: warrantySchemas.list }), controller.listWarranties);
warrantyRouter.get('/summary', requirePermission('VIEW_WARRANTY'), controller.warrantySummary);
warrantyRouter.get('/serial/:serialId', requirePermission('VIEW_WARRANTY'),
  validate(serialParam), controller.serialWarrantyHistory);
warrantyRouter.get('/:id', requirePermission('VIEW_WARRANTY'),
  validate({ params: idParamSchema }), controller.getWarranty);

// Voiding and extending both change what a customer is entitled to, so both
// sit behind VOID_WARRANTY rather than UPDATE_WARRANTY.
warrantyRouter.post('/:id/void', requirePermission('VOID_WARRANTY'),
  validate(warrantySchemas.void), controller.voidWarranty);
warrantyRouter.post('/:id/extend', requirePermission('VOID_WARRANTY'),
  validate(warrantySchemas.extend), controller.extendWarranty);

export const serviceRouter = Router();
serviceRouter.use(authenticate);

serviceRouter.get('/', requirePermission('VIEW_SERVICE_REQUEST'),
  validate({ query: serviceSchemas.list }), controller.listServiceRequests);
serviceRouter.post('/', requirePermission('CREATE_SERVICE_REQUEST'),
  validate(serviceSchemas.create), controller.createServiceRequest);
serviceRouter.get('/serial/:serialId', requirePermission('VIEW_SERVICE_REQUEST'),
  validate(serialParam), controller.serialServiceHistory);
serviceRouter.get('/:id', requirePermission('VIEW_SERVICE_REQUEST'),
  validate({ params: idParamSchema }), controller.getServiceRequest);

serviceRouter.post('/:id/assign', requirePermission('ASSIGN_SERVICE_REQUEST'),
  validate(serviceSchemas.assign), controller.assignServiceRequest);

// Working a ticket — receiving, progressing, repairing, replacing — is the
// engineer's job, distinct from assigning it.
serviceRouter.post('/:id/receive', requirePermission('WORK_SERVICE_REQUEST'),
  validate(serviceSchemas.receive), controller.receiveForService);
serviceRouter.post('/:id/status', requirePermission('WORK_SERVICE_REQUEST'),
  validate(serviceSchemas.status), controller.updateServiceStatus);
serviceRouter.post('/:id/return', requirePermission('WORK_SERVICE_REQUEST'),
  validate(serviceSchemas.returnUnit), controller.returnRepairedUnit);
serviceRouter.post('/:id/replace', requirePermission('WORK_SERVICE_REQUEST'),
  validate(serviceSchemas.replace), controller.replaceUnit);
serviceRouter.post('/:id/close', requirePermission('WORK_SERVICE_REQUEST'),
  validate(serviceSchemas.close), controller.closeServiceRequest);

export default warrantyRouter;

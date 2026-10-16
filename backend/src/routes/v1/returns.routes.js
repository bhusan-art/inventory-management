import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/returns.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { customerReturnSchemas, vendorReturnSchemas } from '../../validators/returns.schema.js';

export const customerReturnRouter = Router();
customerReturnRouter.use(authenticate);

customerReturnRouter.get('/', requirePermission('VIEW_RETURN'),
  validate({ query: customerReturnSchemas.list }), controller.listCustomerReturns);

// Declared before /:id so "disposition-queue" is not read as an id.
customerReturnRouter.get('/disposition-queue', requirePermission('VIEW_RETURN'),
  controller.dispositionQueue);

customerReturnRouter.get('/serial/:serialId', requirePermission('VIEW_RETURN'),
  validate({ params: z.object({ serialId: objectIdSchema }) }), controller.serialReturnHistory);

customerReturnRouter.get('/:id', requirePermission('VIEW_RETURN'),
  validate({ params: idParamSchema }), controller.getCustomerReturn);

customerReturnRouter.post('/', requirePermission('CREATE_RETURN'),
  validate(customerReturnSchemas.create), controller.createCustomerReturn);

// Approving a return commits the company to taking goods back, so it is its
// own permission rather than part of UPDATE_RETURN.
customerReturnRouter.post('/:id/status', requirePermission('APPROVE_RETURN'),
  validate(customerReturnSchemas.status), controller.setCustomerReturnStatus);

// Receiving is a warehouse act: it is the moment stock changes, so it sits with
// the people who handle goods rather than the people who authorise paperwork.
customerReturnRouter.post('/:id/receive', requirePermission('CREATE_GRN'),
  validate(customerReturnSchemas.receive), controller.receiveCustomerReturn);

// Deciding what happens to returned goods is the one that can quietly put a
// faulty unit back on the shelf, which is why it has a permission of its own.
customerReturnRouter.post('/:id/disposition', requirePermission('SET_DISPOSITION'),
  validate(customerReturnSchemas.disposition), controller.setDisposition);

customerReturnRouter.post('/:id/vendor-return', requirePermission('CREATE_RETURN'),
  validate(vendorReturnSchemas.fromCustomerReturn), controller.vendorReturnFromCustomerReturn);

export const vendorReturnRouter = Router();
vendorReturnRouter.use(authenticate);

vendorReturnRouter.get('/', requirePermission('VIEW_RETURN'),
  validate({ query: vendorReturnSchemas.list }), controller.listVendorReturns);

vendorReturnRouter.get('/:id', requirePermission('VIEW_RETURN'),
  validate({ params: idParamSchema }), controller.getVendorReturn);

vendorReturnRouter.post('/', requirePermission('CREATE_RETURN'),
  validate(vendorReturnSchemas.create), controller.createVendorReturn);

vendorReturnRouter.post('/:id/status', requirePermission('APPROVE_RETURN'),
  validate(vendorReturnSchemas.status), controller.setVendorReturnStatus);

// Sending is irreversible — the serials reach RETURNED_TO_VENDOR, which the
// transition table makes a dead end.
vendorReturnRouter.post('/:id/send', requirePermission('APPROVE_RETURN'),
  validate(vendorReturnSchemas.send), controller.sendVendorReturn);

export default customerReturnRouter;

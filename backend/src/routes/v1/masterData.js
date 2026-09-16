import { Router } from 'express';
import { z } from 'zod';
import { createMasterRouter } from './master.routes.js';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { ok } from '../../utils/response.js';
import { idParamSchema } from '../../validators/common.schema.js';
import {
  categoryService, subcategoryService, brandService, manufacturerService,
  warehouseService, vendorService, customerService, productService,
} from '../../services/master/index.js';
import {
  categorySchemas, subcategorySchemas, brandSchemas, manufacturerSchemas,
  warehouseSchemas, vendorSchemas, customerSchemas, productSchemas, importSchema,
} from '../../validators/master.schema.js';
import { getBankDetails } from '../../controllers/vendor.controller.js';
import { importProducts } from '../../services/master/productImport.js';

export const categoryRouter = createMasterRouter({
  service: categoryService, permissionModule: 'CATEGORY', schemas: categorySchemas,
}).router;

export const subcategoryRouter = createMasterRouter({
  service: subcategoryService, permissionModule: 'CATEGORY', schemas: subcategorySchemas,
}).router;

export const brandRouter = createMasterRouter({
  service: brandService, permissionModule: 'CATEGORY', schemas: brandSchemas,
}).router;

export const manufacturerRouter = createMasterRouter({
  service: manufacturerService, permissionModule: 'CATEGORY', schemas: manufacturerSchemas,
}).router;

export const warehouseRouter = createMasterRouter({
  service: warehouseService, permissionModule: 'WAREHOUSE', schemas: warehouseSchemas,
}).router;

export const customerRouter = createMasterRouter({
  service: customerService, permissionModule: 'CUSTOMER', schemas: customerSchemas,
}).router;

// ------------------------------------------------------------------ vendor
const vendorBase = createMasterRouter({
  service: vendorService, permissionModule: 'VENDOR', schemas: vendorSchemas,
});

const vendorExtras = Router();
vendorExtras.use(authenticate);
vendorExtras.get(
  '/:id/bank-details',
  requirePermission('VIEW_VENDOR', 'VIEW_VENDOR_BANK_DETAILS'),
  validate({ params: idParamSchema }),
  getBankDetails,
);
// Mounted ahead of the generic router so /:id/bank-details is not swallowed
// by the /:id route.
export const vendorRouter = Router().use(vendorExtras).use(vendorBase.router);

// ----------------------------------------------------------------- product
const productBase = createMasterRouter({
  service: productService, permissionModule: 'PRODUCT', schemas: productSchemas,
});

const productExtras = Router();
productExtras.use(authenticate);

productExtras.post(
  '/import',
  requirePermission('CREATE_PRODUCT'),
  validate(importSchema),
  asyncHandler(async (req, res) => {
    const summary = await importProducts(req.actor, req.body);
    return ok(res, { message: summary.message, data: summary });
  }),
);

productExtras.get(
  '/import/template',
  requirePermission('CREATE_PRODUCT'),
  asyncHandler(async (req, res) => {
    const headers = [
      'name', 'sku', 'productCode', 'category', 'subcategory', 'brand', 'manufacturer',
      'productType', 'unitOfMeasure', 'modelNumber', 'hsnCode', 'warrantyMonths',
      'minStockLevel', 'reorderLevel', 'maxStockLevel', 'description',
    ];
    const example = [
      'Dell PowerEdge R760', 'SRV-DELL-R760', 'PC-0001', 'IT-HARDWARE', 'SERVER',
      'DELL', 'DELL-TECH', 'SERIALIZED', 'PCS', 'R760', '84713010', '36',
      '1', '2', '20', 'Rack server',
    ];
    res.type('text/csv').attachment('product-import-template.csv');
    return res.send(`${headers.join(',')}\n${example.join(',')}\n`);
  }),
);

export const productRouter = Router().use(productExtras).use(productBase.router);

export const masterRouteSpecs = z.object({}); // placeholder for OpenAPI generation in Phase 12

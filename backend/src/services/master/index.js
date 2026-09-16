import mongoose from 'mongoose';
import { Category, Subcategory, Brand, Manufacturer } from '../../models/classification.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Vendor } from '../../models/Vendor.js';
import { Customer } from '../../models/Customer.js';
import { Product } from '../../models/Product.js';
import { createCrudService } from '../shared/crudFactory.js';
import { DomainError, NotFoundError } from '../../utils/errors.js';

/** Referenced ids must exist, belong to this tenant, and be ACTIVE. */
async function assertReference(modelName, id, tenantId, field) {
  if (!id) return;
  const model = mongoose.models[modelName];
  const doc = await model.findOne({ _id: id, tenantId, deletedAt: null });
  if (!doc) {
    throw new NotFoundError(`The selected ${field} does not exist`, 'REFERENCE_NOT_FOUND');
  }
  if (doc.status && doc.status !== 'ACTIVE') {
    throw new DomainError(`The selected ${field} is not active`, 'REFERENCE_INACTIVE');
  }
  return doc;
}

export const categoryService = createCrudService({
  model: Category,
  modelName: 'Category',
  uniqueFields: ['code', 'name'],
  searchFields: ['name', 'code', 'description'],
  defaultSort: { name: 1 },
  auditFields: ['name', 'code', 'description', 'status'],
});

export const subcategoryService = createCrudService({
  model: Subcategory,
  modelName: 'Subcategory',
  uniqueFields: ['code'],
  searchFields: ['name', 'code'],
  defaultSort: { name: 1 },
  populate: [{ path: 'category', select: 'name code' }],
  auditFields: ['name', 'code', 'category', 'status'],
  beforeCreate: ({ actor, payload }) =>
    assertReference('Category', payload.category, actor.tenantId, 'category'),
  beforeUpdate: ({ actor, payload }) =>
    assertReference('Category', payload.category, actor.tenantId, 'category'),
});

export const brandService = createCrudService({
  model: Brand,
  modelName: 'Brand',
  uniqueFields: ['code', 'name'],
  searchFields: ['name', 'code'],
  defaultSort: { name: 1 },
  auditFields: ['name', 'code', 'status'],
});

export const manufacturerService = createCrudService({
  model: Manufacturer,
  modelName: 'Manufacturer',
  uniqueFields: ['code', 'name'],
  searchFields: ['name', 'code', 'website'],
  defaultSort: { name: 1 },
  auditFields: ['name', 'code', 'website', 'supportEmail', 'status'],
});

export const warehouseService = createCrudService({
  model: Warehouse,
  modelName: 'Warehouse',
  uniqueFields: ['code', 'name'],
  searchFields: ['name', 'code', 'address.city'],
  defaultSort: { name: 1 },
  populate: [{ path: 'manager', select: 'fullName email' }],
  auditFields: ['name', 'code', 'type', 'manager', 'status', 'racks'],
  beforeUpdate: ({ doc, payload }) => {
    // Re-typing TRANSIT or SCRAP would break the transfer model, which relies
    // on exactly one warehouse of each kind existing.
    if (doc.isSystem && payload.type && payload.type !== doc.type) {
      throw new DomainError('The type of a system warehouse cannot be changed', 'SYSTEM_RECORD_PROTECTED');
    }
  },
});

export const vendorService = createCrudService({
  model: Vendor,
  modelName: 'Vendor',
  auditModule: 'VENDOR',
  uniqueFields: ['vendorCode'],
  searchFields: ['vendorName', 'vendorCode', 'contactPerson', 'gstin'],
  defaultSort: { vendorName: 1 },
  // Contact and bank fields are deliberately absent: they are restricted, and
  // writing their values into an audit diff would be a read channel around the
  // serializer. auditService redacts them anyway; this is belt and braces.
  auditFields: ['vendorName', 'vendorCode', 'contactPerson', 'gstin', 'pan', 'leadTimeDays', 'status'],
});

export const customerService = createCrudService({
  model: Customer,
  modelName: 'Customer',
  auditModule: 'CUSTOMER',
  uniqueFields: ['customerCode'],
  searchFields: ['customerName', 'customerCode', 'companyName', 'contactPerson', 'gstin'],
  defaultSort: { customerName: 1 },
  auditFields: ['customerName', 'customerCode', 'companyName', 'customerType', 'gstin', 'pan', 'status'],
});

/**
 * Products need three rules the factory does not provide, so the generic
 * service is wrapped rather than replaced.
 */
const baseProductService = createCrudService({
  model: Product,
  modelName: 'Product',
  uniqueFields: ['sku', 'productCode'],
  searchFields: ['name', 'sku', 'productCode', 'modelNumber'],
  defaultSort: { name: 1 },
  populate: [
    { path: 'category', select: 'name code' },
    { path: 'subcategory', select: 'name code' },
    { path: 'brand', select: 'name code' },
    { path: 'manufacturer', select: 'name code' },
  ],
  auditFields: [
    'name', 'sku', 'productCode', 'category', 'subcategory', 'brand', 'manufacturer',
    'productType', 'unitOfMeasure', 'minStockLevel', 'reorderLevel', 'maxStockLevel',
    'warrantyMonths', 'serialFormatPattern', 'status',
  ],
  beforeCreate: async ({ actor, payload }) => {
    await assertReference('Category', payload.category, actor.tenantId, 'category');
    await assertReference('Subcategory', payload.subcategory, actor.tenantId, 'subcategory');
    await assertReference('Brand', payload.brand, actor.tenantId, 'brand');
    await assertReference('Manufacturer', payload.manufacturer, actor.tenantId, 'manufacturer');
    validateSerialPattern(payload.serialFormatPattern);
  },
  beforeUpdate: async ({ actor, doc, payload }) => {
    await assertReference('Category', payload.category, actor.tenantId, 'category');
    await assertReference('Subcategory', payload.subcategory, actor.tenantId, 'subcategory');
    await assertReference('Brand', payload.brand, actor.tenantId, 'brand');
    await assertReference('Manufacturer', payload.manufacturer, actor.tenantId, 'manufacturer');
    validateSerialPattern(payload.serialFormatPattern);

    if (payload.productType && payload.productType !== doc.productType) {
      await assertNoStockMovement(doc);
    }
  },
});

/**
 * A product type may only change while the product has never held stock.
 *
 * Flipping SERIALIZED → NON_SERIALIZED after units exist orphans every serial
 * record; the reverse leaves quantities with no serials to account for them.
 * Either way the ledger stops reconciling, and there is no clean repair.
 *
 * Phase 3 registers InventoryTransaction; until then there is provably no
 * movement, so the check passes trivially rather than being absent.
 */
async function assertNoStockMovement(product) {
  const Ledger = mongoose.models.InventoryTransaction;
  if (!Ledger) return;

  const moved = await Ledger.countDocuments({ product: product._id });
  if (moved > 0) {
    throw new DomainError(
      'This product has stock history, so its type can no longer be changed. ' +
        'Create a new product instead.',
      'PRODUCT_TYPE_LOCKED',
    );
  }
}

/** An invalid regex would throw at receiving time, not at save time. */
function validateSerialPattern(pattern) {
  if (!pattern) return;
  try {
    RegExp(pattern);
  } catch {
    throw new DomainError('The serial number format is not a valid pattern', 'INVALID_SERIAL_PATTERN');
  }
}

export const productService = { ...baseProductService, assertNoStockMovement, validateSerialPattern };

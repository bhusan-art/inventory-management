import mongoose from 'mongoose';
import { ConflictError } from '../../utils/errors.js';

/**
 * Blocks deletion of a record that other records still point at.
 *
 * Cascading would be the alternative, and it is the wrong one here: deleting a
 * category should not silently delete every product in it, and nulling the
 * reference leaves products in a state the UI cannot render and the reports
 * cannot group. Refusing, and naming what blocks it, lets the user decide.
 *
 * Declared as data rather than written per-service so that every master-data
 * delete behaves identically, and so Phase 3+ can add references to existing
 * entities by appending one line.
 */
export const REFERENCES = {
  Category: [
    { model: 'Product', field: 'category', label: 'products' },
    { model: 'Subcategory', field: 'category', label: 'subcategories' },
  ],
  Subcategory: [{ model: 'Product', field: 'subcategory', label: 'products' }],
  Brand: [{ model: 'Product', field: 'brand', label: 'products' }],
  Manufacturer: [{ model: 'Product', field: 'manufacturer', label: 'products' }],
  Warehouse: [
    { model: 'User', field: 'scope.warehouseIds', label: 'users scoped to it' },
    { model: 'Inventory', field: 'warehouse', label: 'inventory records' },
    { model: 'PurchaseOrder', field: 'warehouse', label: 'purchase orders' },
    { model: 'GRN', field: 'warehouse', label: 'goods receipts' },
    { model: 'StockCount', field: 'warehouse', label: 'stock counts' },
    { model: 'WarehouseTransfer', field: 'sourceWarehouse', label: 'outgoing transfers' },
    { model: 'WarehouseTransfer', field: 'destinationWarehouse', label: 'incoming transfers' },
    { model: 'DispatchNote', field: 'warehouse', label: 'dispatch notes' },
    { model: 'SalesOrder', field: 'warehouse', label: 'sales orders' },
  ],
  Vendor: [
    { model: 'PurchaseOrder', field: 'vendor', label: 'purchase orders' },
    { model: 'GRN', field: 'vendor', label: 'goods receipts' },
  ],
  Customer: [
    { model: 'SalesOrder', field: 'customer', label: 'sales orders' },
    { model: 'DispatchNote', field: 'customer', label: 'dispatch notes' },
    { model: 'Warranty', field: 'customer', label: 'warranties' },
    { model: 'SerialNumber', field: 'customer', label: 'units they hold' },
  ],
  Product: [
    { model: 'Inventory', field: 'product', label: 'inventory records' },
    { model: 'SerialNumber', field: 'product', label: 'serial numbers' },
    { model: 'PurchaseOrder', field: 'lines.product', label: 'purchase order lines' },
    { model: 'GRN', field: 'lines.product', label: 'goods receipt lines' },
    { model: 'WarehouseTransfer', field: 'lines.product', label: 'transfer lines' },
    { model: 'SalesOrder', field: 'lines.product', label: 'sales order lines' },
    { model: 'DispatchNote', field: 'lines.product', label: 'dispatch lines' },
  ],
};

/**
 * @throws ConflictError naming each blocking collection and its count.
 */
export async function assertNotReferenced(modelName, recordId, { tenantId } = {}) {
  const checks = REFERENCES[modelName] ?? [];
  const blockers = [];

  for (const check of checks) {
    const model = mongoose.models[check.model];
    // A reference to a collection a later phase introduces is simply skipped
    // until that phase registers the model.
    if (!model) continue;

    const filter = { [check.field]: recordId, deletedAt: null };
    if (tenantId && model.schema.path('tenantId')) filter.tenantId = tenantId;

    const count = await model.countDocuments(filter);
    if (count > 0) blockers.push({ ...check, count });
  }

  if (blockers.length > 0) {
    const summary = blockers.map((b) => `${b.count} ${b.label}`).join(', ');
    throw new ConflictError(
      `This record is still in use by ${summary}. Reassign or remove them first.`,
      'REFERENCE_IN_USE',
      blockers.map((b) => ({
        code: 'REFERENCE_IN_USE',
        collection: b.model,
        field: b.field,
        count: b.count,
      })),
    );
  }
}

export default assertNotReferenced;

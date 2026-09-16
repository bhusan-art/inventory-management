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
    // Phase 3+ appends: Inventory, GRN, Transfer, DispatchNote.
  ],
  Vendor: [
    // Phase 3 appends: PurchaseOrder, GRN.
  ],
  Customer: [
    // Phase 7 appends: SalesOrder, DispatchNote, Warranty.
  ],
  Product: [
    // Phase 3+ appends: Inventory, SerialNumber, PurchaseOrder lines.
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

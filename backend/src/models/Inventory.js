import mongoose from 'mongoose';

/**
 * Current stock — a materialized projection of the ledger, not the source of
 * truth (ARCHITECTURE.md §0.7).
 *
 * It exists because summing millions of ledger rows on every stock page load
 * does not scale. A nightly job recomputes each row from the ledger and raises
 * a drift alert on any mismatch, rather than silently self-healing: drift is a
 * bug signal, and auto-correcting it hides the bug.
 */
const inventorySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    rackLocation: { type: String, trim: true, uppercase: true, maxlength: 40, default: null },

    availableQuantity: { type: Number, default: 0, min: 0 },
    reservedQuantity: { type: Number, default: 0, min: 0 },
    damagedQuantity: { type: Number, default: 0, min: 0 },
    inTransitQuantity: { type: Number, default: 0, min: 0 },
    underServiceQuantity: { type: Number, default: 0, min: 0 },

    lastTransactionAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * One row per product per warehouse. This uniqueness is what makes the guarded
 * `$inc` atomic — without it, two rows could exist and concurrent updates
 * would each decrement a different one.
 */
inventorySchema.index({ tenantId: 1, product: 1, warehouse: 1 }, { unique: true });
inventorySchema.index({ tenantId: 1, warehouse: 1, availableQuantity: 1 });
inventorySchema.index({ tenantId: 1, product: 1 });

inventorySchema.virtual('totalQuantity').get(function total() {
  return this.availableQuantity + this.reservedQuantity + this.damagedQuantity
    + this.inTransitQuantity + this.underServiceQuantity;
});

inventorySchema.set('toObject', { virtuals: true });
inventorySchema.set('toJSON', { virtuals: true });

export const Inventory = mongoose.model('Inventory', inventorySchema);
export default Inventory;

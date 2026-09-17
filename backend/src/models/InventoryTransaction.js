import mongoose from 'mongoose';
import { TRANSACTION_TYPES, REFERENCE_TYPES, BUCKET_NAMES } from '../constants/inventory.js';

/**
 * The ledger. Append-only, and the authoritative record of every stock
 * movement the system has ever made.
 *
 * There is no update or delete path — the hooks below make both impossible at
 * the ODM level. Corrections are new rows referencing `reversalOf`, so the
 * mistake and its correction are both permanently visible. A ledger you can
 * edit is not a ledger.
 */
const inventoryTransactionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    transactionNumber: { type: String, required: true },

    transactionType: { type: String, enum: TRANSACTION_TYPES, required: true },
    direction: { type: String, enum: ['IN', 'OUT', 'NEUTRAL'], required: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    serialNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber', default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    /**
     * Which bucket the quantity moved out of and into. NEUTRAL movements
     * (a reservation) name both; an IN names only `bucketTo`.
     */
    bucketFrom: { type: String, enum: [...BUCKET_NAMES, null], default: null },
    bucketTo: { type: String, enum: [...BUCKET_NAMES, null], default: null },

    quantityBefore: { type: Number, required: true },
    quantityChange: { type: Number, required: true },
    quantityAfter: { type: Number, required: true },

    referenceType: { type: String, enum: REFERENCE_TYPES, required: true },
    referenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: null },

    reasonCode: { type: String, default: null },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryTransaction', default: null },
    remarks: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inventoryTransactionSchema.index({ tenantId: 1, transactionNumber: 1 }, { unique: true });
inventoryTransactionSchema.index({ tenantId: 1, product: 1, warehouse: 1, createdAt: -1 });
inventoryTransactionSchema.index({ tenantId: 1, referenceType: 1, referenceId: 1 });
inventoryTransactionSchema.index({ tenantId: 1, serialNumber: 1, createdAt: -1 });
inventoryTransactionSchema.index({ tenantId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ tenantId: 1, transactionType: 1, createdAt: -1 });

const immutable = function immutable(next) {
  next(new Error('The inventory ledger is append-only. Post a reversing entry instead.'));
};

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  inventoryTransactionSchema.pre(op, immutable);
}

export const InventoryTransaction = mongoose.model('InventoryTransaction', inventoryTransactionSchema);
export default InventoryTransaction;

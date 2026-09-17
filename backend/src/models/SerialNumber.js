import mongoose from 'mongoose';
import { SERIAL_STATUSES } from '../constants/inventory.js';

const serialNumberSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    serialNumber: { type: String, required: true, uppercase: true, trim: true, maxlength: 80 },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    imei: { type: String, uppercase: true, trim: true, maxlength: 20, default: null },
    macAddress: { type: String, uppercase: true, trim: true, maxlength: 20, default: null },
    assetTag: { type: String, uppercase: true, trim: true, maxlength: 40, default: null },

    status: { type: String, enum: SERIAL_STATUSES, required: true, default: 'RECEIVED' },
    condition: { type: String, enum: ['NEW', 'REFURBISHED', 'DAMAGED', 'SCRAP'], default: 'NEW' },

    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    rackLocation: { type: String, uppercase: true, trim: true, maxlength: 40, default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    grn: { type: mongoose.Schema.Types.ObjectId, ref: 'GRN', default: null },
    dispatchNote: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchNote', default: null },

    batchNumber: { type: String, trim: true, maxlength: 60, default: null },
    manufacturingDate: { type: Date, default: null },
    receivedDate: { type: Date, default: null },
    dispatchDate: { type: Date, default: null },

    currentWarranty: { type: mongoose.Schema.Types.ObjectId, ref: 'Warranty', default: null },
    installationLocation: { type: String, trim: true, maxlength: 200, default: null },

    remarks: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

/**
 * Globally unique, forever, including across soft-deleted records.
 *
 * This is the one place the partial-index convention is deliberately broken.
 * Reusing a serial number would merge two physical units' histories, and the
 * asset traceability this whole system exists to provide would be silently
 * wrong from that point on.
 */
serialNumberSchema.index({ tenantId: 1, serialNumber: 1 }, { unique: true });
serialNumberSchema.index({ tenantId: 1, product: 1, status: 1 });
serialNumberSchema.index({ tenantId: 1, warehouse: 1, status: 1 });
serialNumberSchema.index({ tenantId: 1, customer: 1 });
serialNumberSchema.index({ tenantId: 1, assetTag: 1 }, { sparse: true });
serialNumberSchema.index({ tenantId: 1, macAddress: 1 }, { sparse: true });

export const SerialNumber = mongoose.model('SerialNumber', serialNumberSchema);

/**
 * Per-unit history, append-only.
 *
 * Separate from the ledger because a serial changes state on events that move
 * no stock: an RMA approved, an asset reassigned within a customer site, a
 * warranty voided. This is what the "history of serial ABC123" screen reads.
 */
const serialNumberEventSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    serialNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber', required: true },

    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    eventType: { type: String, required: true },

    referenceType: { type: String, default: null },
    referenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    referenceNumber: { type: String, default: null },

    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    remarks: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

serialNumberEventSchema.index({ tenantId: 1, serialNumber: 1, createdAt: -1 });

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany']) {
  serialNumberEventSchema.pre(op, function immutable(next) {
    next(new Error('Serial number history is append-only.'));
  });
}

export const SerialNumberEvent = mongoose.model('SerialNumberEvent', serialNumberEventSchema);

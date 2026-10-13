import mongoose from 'mongoose';

/**
 * Warranty.
 *
 * `state` holds only facts that must be STORED — a human decision or a claim
 * outcome. Active / expiring-soon / expired is DERIVED from `endDate` at read
 * time (see utils/dates.js). No job ever rewrites these rows.
 */
const warrantySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    warrantyNumber: { type: String, required: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    serialNumber: { type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    dispatchNote: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchNote', default: null },

    dispatchDate: { type: Date, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    durationMonths: { type: Number, required: true, min: 0 },

    provider: {
      type: String,
      enum: ['MANUFACTURER', 'VENDOR', 'IN_HOUSE', 'EXTENDED'],
      default: 'MANUFACTURER',
    },
    terms: { type: String, trim: true, maxlength: 2000 },

    state: {
      type: String,
      enum: ['ACTIVE', 'VOID', 'CLAIMED_REPLACED', 'TRANSFERRED'],
      default: 'ACTIVE',
      index: true,
    },
    voidReason: { type: String, trim: true, maxlength: 300, default: null },

    /** Set when a replacement unit inherits the original's end date. */
    previousWarranty: { type: mongoose.Schema.Types.ObjectId, ref: 'Warranty', default: null },

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

warrantySchema.index({ tenantId: 1, warrantyNumber: 1 }, { unique: true });
// Drives every alert query in Phase 8.
warrantySchema.index({ tenantId: 1, endDate: 1, state: 1 });
warrantySchema.index({ tenantId: 1, serialNumber: 1, startDate: -1 });
warrantySchema.index({ tenantId: 1, customer: 1 });

export const Warranty = mongoose.model('Warranty', warrantySchema);
export default Warranty;

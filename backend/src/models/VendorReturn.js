import mongoose from 'mongoose';
import { VENDOR_RETURN_REASONS, VENDOR_RETURN_SOURCE_BUCKETS } from '../constants/returns.js';

/**
 * A vendor return (RTV) — goods going back to whoever supplied them.
 *
 * The mirror of a GRN, and it borrows the GRN's most important property: the
 * stock does not move when the document is created, only when it is SENT. A
 * return being prepared over an afternoon must not make stock vanish from the
 * shelf, because it is still on the shelf.
 */
const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    serialNumbers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber' }],

    /**
     * Which bucket the goods leave from.
     *
     * Both are legitimate and they mean different things. DAMAGED is the usual
     * case — a faulty unit, or one a customer returned. AVAILABLE covers an
     * over-delivery: perfectly good stock going back because we never ordered
     * it. The ledger must say which, or a warranty claim and a surplus return
     * look identical in the history.
     */
    sourceBucket: {
      type: String,
      enum: VENDOR_RETURN_SOURCE_BUCKETS,
      required: true,
      default: 'DAMAGED',
    },

    /** Set when these goods arrived as a customer return. */
    customerReturn: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerReturn', default: null },
    remarks: { type: String, trim: true, maxlength: 500 },
  },
  { _id: true },
);

const vendorReturnSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    returnNumber: { type: String, required: true },

    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    /** The receipt these goods came in on, where known. */
    grn: { type: mongoose.Schema.Types.ObjectId, ref: 'GRN', default: null },

    reason: { type: String, enum: VENDOR_RETURN_REASONS, required: true },
    reasonDetail: { type: String, trim: true, maxlength: 1000 },

    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'SENT', 'CLOSED'],
      default: 'DRAFT',
      index: true,
    },

    lines: { type: [lineSchema], validate: [(v) => v.length > 0, 'A return needs at least one line'] },

    /**
     * Whether a replacement is expected back.
     *
     * Deliberately a flag and not a workflow. When the replacement arrives it
     * comes in as an ordinary GRN, because that is what it is — goods at the
     * dock needing inspection. Modelling it as a return that un-returns itself
     * would invent a second receiving path with none of the GRN's checks.
     */
    expectReplacement: { type: Boolean, default: false },

    vendorRmaNumber: { type: String, trim: true, maxlength: 60, default: null },
    courier: { type: String, trim: true, maxlength: 100, default: null },
    trackingNumber: { type: String, trim: true, maxlength: 100, default: null },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: null },
    sentAt: { type: Date, default: null },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    closureNotes: { type: String, trim: true, maxlength: 1000, default: null },

    idempotencyKey: { type: String, default: null },

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

vendorReturnSchema.index({ tenantId: 1, returnNumber: 1 }, { unique: true });
vendorReturnSchema.index({ tenantId: 1, vendor: 1, status: 1 });
vendorReturnSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

vendorReturnSchema.virtual('totalQuantity').get(function total() {
  return (this.lines ?? []).reduce((sum, l) => sum + l.quantity, 0);
});

vendorReturnSchema.set('toObject', { virtuals: true });
vendorReturnSchema.set('toJSON', { virtuals: true });

export const VendorReturn = mongoose.model('VendorReturn', vendorReturnSchema);
export default VendorReturn;

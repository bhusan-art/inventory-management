import mongoose from 'mongoose';
import { CUSTOMER_RETURN_REASONS, DISPOSITIONS } from '../constants/returns.js';

/**
 * A customer return (RMA).
 *
 * Quantities here are the only place in the system where three numbers for one
 * line are all legitimately different:
 *
 *   requestedQuantity  what the customer says they are sending back
 *   receivedQuantity   what actually arrived
 *   dispositionedQuantity  how much has been inspected and decided on
 *
 * Collapsing them would destroy the two facts worth having: that a customer
 * claimed five and sent four, and that two of those four are still sitting on
 * the inspection bench. Both are questions somebody asks.
 */
const dispositionSchema = new mongoose.Schema(
  {
    disposition: { type: String, enum: DISPOSITIONS, required: true },
    quantity: { type: Number, required: true, min: 1 },
    serialNumbers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber' }],
    // Where the goods went, when the disposition sends them somewhere.
    vendorReturn: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorReturn', default: null },
    inspectionNotes: { type: String, trim: true, maxlength: 1000 },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    requestedQuantity: { type: Number, required: true, min: 1 },
    receivedQuantity: { type: Number, default: 0, min: 0 },

    /** Units claimed by the customer, resolved at receipt. */
    serialNumbers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SerialNumber' }],

    reportedCondition: { type: String, trim: true, maxlength: 500 },
    dispositions: [dispositionSchema],
    remarks: { type: String, trim: true, maxlength: 500 },
  },
  { _id: true },
);

/** How much of a line has been decided on. Derived, never stored. */
lineSchema.virtual('dispositionedQuantity').get(function dispositioned() {
  return (this.dispositions ?? []).reduce((sum, d) => sum + d.quantity, 0);
});

lineSchema.virtual('pendingQuantity').get(function pending() {
  return Math.max(0, this.receivedQuantity - this.dispositionedQuantity);
});

lineSchema.set('toObject', { virtuals: true });
lineSchema.set('toJSON', { virtuals: true });

const customerReturnSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    returnNumber: { type: String, required: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    /**
     * The dispatch this came from, when it is known.
     *
     * Optional on purpose. A customer returning a unit two years later may not
     * have the paperwork, and refusing the return because our reference is
     * missing would be our problem becoming theirs. When it IS supplied, the
     * service checks the quantity against what that note actually shipped.
     */
    dispatchNote: { type: mongoose.Schema.Types.ObjectId, ref: 'DispatchNote', default: null },

    reason: { type: String, enum: CUSTOMER_RETURN_REASONS, required: true },
    reasonDetail: { type: String, trim: true, maxlength: 1000 },

    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'RECEIVED', 'CLOSED'],
      default: 'DRAFT',
      index: true,
    },

    lines: { type: [lineSchema], validate: [(v) => v.length > 0, 'A return needs at least one line'] },

    requestedDate: { type: Date, required: true, default: Date.now },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: null },
    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },

    /**
     * Set when receiving the goods voided the customer's warranty.
     *
     * Taking a unit back ends the cover on it — the customer no longer has the
     * thing. Recorded here so the decision is traceable to this return rather
     * than looking like an unexplained void on the warranty.
     */
    warrantiesVoided: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Warranty' }],

    /** Guards against a double-submitted receipt. */
    idempotencyKey: { type: String, default: null },

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customerReturnSchema.index({ tenantId: 1, returnNumber: 1 }, { unique: true });
customerReturnSchema.index({ tenantId: 1, customer: 1, status: 1 });
customerReturnSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

/** Everything received but not yet decided on, across all lines. */
customerReturnSchema.virtual('pendingDispositionQuantity').get(function pending() {
  return (this.lines ?? []).reduce(
    (sum, l) => sum + Math.max(0, l.receivedQuantity - (l.dispositions ?? []).reduce((s, d) => s + d.quantity, 0)),
    0,
  );
});

customerReturnSchema.set('toObject', { virtuals: true });
customerReturnSchema.set('toJSON', { virtuals: true });

export const CustomerReturn = mongoose.model('CustomerReturn', customerReturnSchema);
export default CustomerReturn;

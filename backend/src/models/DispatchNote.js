import mongoose from 'mongoose';

const dispatchLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    salesOrderLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    quantity: { type: Number, required: true, min: 1 },
    serialNumbers: [{ type: String, uppercase: true, trim: true }],
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

/**
 * Goods leaving for a customer.
 *
 * Called a dispatch note, not an invoice: this system holds no money
 * (ARCHITECTURE.md §0.1). It is a delivery challan — what left, when, to whom,
 * and with which serial numbers.
 */
const dispatchNoteSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    dispatchNoteNumber: { type: String, required: true },

    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    dispatchDate: { type: Date, required: true, default: Date.now },
    deliveredDate: { type: Date, default: null },
    receivedByName: { type: String, trim: true, maxlength: 120, default: null },

    shippingAddress: {
      label: String, line1: String, line2: String,
      city: String, state: String, postalCode: String, country: String,
    },
    vehicleNumber: { type: String, uppercase: true, trim: true, maxlength: 20, default: null },
    transporter: { type: String, trim: true, maxlength: 120, default: null },
    lrNumber: { type: String, trim: true, maxlength: 60, default: null },

    status: {
      type: String,
      enum: ['DISPATCHED', 'DELIVERED', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED'],
      default: 'DISPATCHED',
      index: true,
    },

    lines: {
      type: [dispatchLineSchema],
      validate: [(v) => v.length > 0 && v.length <= 200, 'A dispatch note needs 1 to 200 lines'],
    },

    /**
     * Idempotency key. A double-clicked button or a retried request after a
     * timeout must not ship the goods twice.
     */
    idempotencyKey: { type: String, default: null },

    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 300, default: null },
    remarks: { type: String, trim: true, maxlength: 500 },
    documents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

dispatchNoteSchema.index({ tenantId: 1, dispatchNoteNumber: 1 }, { unique: true });
dispatchNoteSchema.index({ tenantId: 1, customer: 1, dispatchDate: -1 });
dispatchNoteSchema.index({ tenantId: 1, salesOrder: 1 });
dispatchNoteSchema.index({ tenantId: 1, warehouse: 1, status: 1 });
dispatchNoteSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const DispatchNote = mongoose.model('DispatchNote', dispatchNoteSchema);
export default DispatchNote;

import mongoose from 'mongoose';

const poLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    orderedQuantity: { type: Number, required: true, min: 1 },

    // Maintained by GRN posting, never set directly by the API.
    receivedQuantity: { type: Number, default: 0, min: 0 },
    rejectedQuantity: { type: Number, default: 0, min: 0 },
    shortClosedQuantity: { type: Number, default: 0, min: 0 },

    expectedDeliveryDate: { type: Date, default: null },
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    poNumber: { type: String, required: true },

    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    orderDate: { type: Date, required: true, default: Date.now },
    expectedDeliveryDate: { type: Date, default: null },

    /**
     * The receiving states are DERIVED from line tallies by
     * `recalculateStatus`, never set by hand. A status that can be typed in is
     * a status that will eventually disagree with the quantities beneath it.
     */
    status: {
      type: String,
      enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED',
        'RECEIVED', 'SHORT_CLOSED', 'CANCELLED'],
      default: 'DRAFT',
      index: true,
    },

    lines: {
      type: [poLineSchema],
      validate: [(v) => v.length > 0 && v.length <= 200, 'A purchase order needs 1 to 200 lines'],
    },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    closedReason: { type: String, trim: true, maxlength: 300, default: null },
    remarks: { type: String, trim: true, maxlength: 500 },
    documents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

purchaseOrderSchema.index({ tenantId: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ tenantId: 1, vendor: 1, orderDate: -1 });
purchaseOrderSchema.index({ tenantId: 1, status: 1, expectedDeliveryDate: 1 });
purchaseOrderSchema.index({ tenantId: 1, warehouse: 1, status: 1 });

/**
 * Derives the receiving status from the lines.
 *
 * Called after every GRN posting. Terminal states (CANCELLED, SHORT_CLOSED)
 * are left alone — they are decisions, not tallies.
 */
purchaseOrderSchema.methods.recalculateStatus = function recalculateStatus() {
  if (['CANCELLED', 'SHORT_CLOSED', 'DRAFT', 'PENDING_APPROVAL'].includes(this.status)) return this.status;

  const totalOrdered = this.lines.reduce((sum, l) => sum + l.orderedQuantity, 0);
  const totalSettled = this.lines.reduce(
    (sum, l) => sum + l.receivedQuantity + l.rejectedQuantity + l.shortClosedQuantity,
    0,
  );

  if (totalSettled === 0) this.status = this.status === 'APPROVED' ? 'APPROVED' : 'SENT';
  else if (totalSettled >= totalOrdered) this.status = 'RECEIVED';
  else this.status = 'PARTIALLY_RECEIVED';

  return this.status;
};

export const PurchaseOrder = mongoose.model('PurchaseOrder', purchaseOrderSchema);
export default PurchaseOrder;

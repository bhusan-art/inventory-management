import mongoose from 'mongoose';

const grnLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    poLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    orderedQuantity: { type: Number, default: 0, min: 0 },
    receivedQuantity: { type: Number, required: true, min: 0 },
    acceptedQuantity: { type: Number, required: true, min: 0 },
    damagedQuantity: { type: Number, default: 0, min: 0 },
    rejectedQuantity: { type: Number, default: 0, min: 0 },
    shortQuantity: { type: Number, default: 0, min: 0 },

    rackLocation: { type: String, uppercase: true, trim: true, maxlength: 40, default: null },
    batchNumber: { type: String, trim: true, maxlength: 60, default: null },
    manufacturingDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },

    serialNumbers: [{ type: String, uppercase: true, trim: true, maxlength: 80 }],
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

/** accepted + damaged + rejected must account for everything received. */
grnLineSchema.pre('validate', function validateSplit(next) {
  const total = this.acceptedQuantity + this.damagedQuantity + this.rejectedQuantity;
  if (total !== this.receivedQuantity) {
    return next(new Error(
      `Accepted (${this.acceptedQuantity}) + damaged (${this.damagedQuantity}) + rejected `
      + `(${this.rejectedQuantity}) must equal received (${this.receivedQuantity})`,
    ));
  }
  return next();
});

const grnSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    grnNumber: { type: String, required: true },

    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    // Optional: direct receipts without a PO are legitimate and common.
    purchaseOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    /**
     * Carries the vendor's own document reference. In a system that tracked
     * money this would live on a separate purchase/bill record; with no
     * amounts to hold, that record had nothing else in it (ARCHITECTURE.md §0.1).
     */
    vendorInvoiceNumber: { type: String, trim: true, maxlength: 60, default: null },
    vendorInvoiceDate: { type: Date, default: null },
    vendorChallanNumber: { type: String, trim: true, maxlength: 60, default: null },

    receivedDate: { type: Date, required: true, default: Date.now },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    vehicleNumber: { type: String, uppercase: true, trim: true, maxlength: 20, default: null },

    status: { type: String, enum: ['DRAFT', 'POSTED', 'CANCELLED'], default: 'DRAFT', index: true },
    postedAt: { type: Date, default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 300, default: null },

    lines: {
      type: [grnLineSchema],
      validate: [(v) => v.length > 0 && v.length <= 200, 'A GRN needs 1 to 200 lines'],
    },

    remarks: { type: String, trim: true, maxlength: 500 },
    documents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

grnSchema.index({ tenantId: 1, grnNumber: 1 }, { unique: true });
grnSchema.index({ tenantId: 1, vendor: 1, receivedDate: -1 });
grnSchema.index({ tenantId: 1, warehouse: 1, status: 1 });
grnSchema.index({ tenantId: 1, purchaseOrder: 1 });

/**
 * The same vendor cannot book the same invoice number twice.
 *
 * With no amounts in the system, this is the duplicate-receipt control that
 * survives: it catches the same delivery being entered twice, which otherwise
 * silently doubles stock.
 */
grnSchema.index(
  { tenantId: 1, vendor: 1, vendorInvoiceNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      vendorInvoiceNumber: { $type: 'string' },
      deletedAt: null,
      status: { $ne: 'CANCELLED' },
    },
  },
);

export const GRN = mongoose.model('GRN', grnSchema);
export default GRN;

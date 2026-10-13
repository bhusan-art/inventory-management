import mongoose from 'mongoose';

const salesOrderLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    orderedQuantity: { type: Number, required: true, min: 1 },

    // Maintained by confirm and dispatch, never set directly by the API.
    reservedQuantity: { type: Number, default: 0, min: 0 },
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    cancelledQuantity: { type: Number, default: 0, min: 0 },

    reservedSerialNumbers: [{ type: String, uppercase: true, trim: true }],
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

const salesOrderSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    salesOrderNumber: { type: String, required: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerPoReference: { type: String, trim: true, maxlength: 60, default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    orderDate: { type: Date, required: true, default: Date.now },
    requiredByDate: { type: Date, default: null },
    projectReference: { type: String, trim: true, maxlength: 120, default: null },

    status: {
      type: String,
      enum: ['DRAFT', 'CONFIRMED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'CANCELLED', 'CLOSED'],
      default: 'DRAFT',
      index: true,
    },

    lines: {
      type: [salesOrderLineSchema],
      validate: [(v) => v.length > 0 && v.length <= 200, 'A sales order needs 1 to 200 lines'],
    },

    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    confirmedAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 300, default: null },

    remarks: { type: String, trim: true, maxlength: 500 },
    documents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],

    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

salesOrderSchema.index({ tenantId: 1, salesOrderNumber: 1 }, { unique: true });
salesOrderSchema.index({ tenantId: 1, customer: 1, orderDate: -1 });
salesOrderSchema.index({ tenantId: 1, status: 1, requiredByDate: 1 });
salesOrderSchema.index({ tenantId: 1, warehouse: 1, status: 1 });

/** Units reserved but not yet dispatched — what is still owed on this order. */
salesOrderSchema.methods.outstandingFor = function outstandingFor(line) {
  return line.orderedQuantity - line.dispatchedQuantity - line.cancelledQuantity;
};

salesOrderSchema.methods.recalculateStatus = function recalculateStatus() {
  if (['DRAFT', 'CANCELLED', 'CLOSED'].includes(this.status)) return this.status;

  const outstanding = this.lines.reduce((sum, l) => sum + this.outstandingFor(l), 0);
  const dispatched = this.lines.reduce((sum, l) => sum + l.dispatchedQuantity, 0);

  if (outstanding === 0) this.status = 'DISPATCHED';
  else if (dispatched > 0) this.status = 'PARTIALLY_DISPATCHED';
  else this.status = 'CONFIRMED';

  return this.status;
};

export const SalesOrder = mongoose.model('SalesOrder', salesOrderSchema);
export default SalesOrder;

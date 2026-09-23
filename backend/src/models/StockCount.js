import mongoose from 'mongoose';

const stockCountLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    /**
     * Snapshotted when the sheet is generated, not read at posting time.
     *
     * A count takes hours. If the system quantity were read at posting, any
     * movement during the count would be silently absorbed into the variance
     * and the count would "explain" a discrepancy it did not measure.
     */
    systemQuantity: { type: Number, required: true, min: 0 },
    countedQuantity: { type: Number, default: null, min: 0 },
    variance: { type: Number, default: null },
    counted: { type: Boolean, default: false },
    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

const stockCountSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    countNumber: { type: String, required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    scope: { type: String, enum: ['FULL', 'CATEGORY', 'PRODUCT_LIST'], default: 'FULL' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },

    status: {
      type: String,
      enum: ['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      default: 'DRAFT',
      index: true,
    },

    snapshotAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    lines: { type: [stockCountLineSchema], default: [] },
    remarks: { type: String, trim: true, maxlength: 500 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

stockCountSchema.index({ tenantId: 1, countNumber: 1 }, { unique: true });
stockCountSchema.index({ tenantId: 1, warehouse: 1, status: 1 });

export const StockCount = mongoose.model('StockCount', stockCountSchema);
export default StockCount;

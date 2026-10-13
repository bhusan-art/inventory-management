import mongoose from 'mongoose';

const transferLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    requestedQuantity: { type: Number, required: true, min: 1 },
    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    receivedQuantity: { type: Number, default: 0, min: 0 },
    damagedInTransitQuantity: { type: Number, default: 0, min: 0 },

    /** Chosen at request time for serialized products — which exact units move. */
    serialNumbers: [{ type: String, uppercase: true, trim: true }],
    /** Filled in as units arrive, so a partial receipt records which ones came. */
    receivedSerials: [{ type: String, uppercase: true, trim: true }],
    damagedSerials: [{ type: String, uppercase: true, trim: true }],

    remarks: { type: String, trim: true, maxlength: 300 },
  },
  { _id: true },
);

const warehouseTransferSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    transferNumber: { type: String, required: true },

    sourceWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    destinationWarehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },

    status: {
      type: String,
      enum: ['PENDING_APPROVAL', 'APPROVED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
      default: 'PENDING_APPROVAL',
      index: true,
    },

    lines: {
      type: [transferLineSchema],
      validate: [(v) => v.length > 0 && v.length <= 200, 'A transfer needs 1 to 200 lines'],
    },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    dispatchedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    receivedAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, trim: true, maxlength: 300, default: null },

    vehicleNumber: { type: String, uppercase: true, trim: true, maxlength: 20, default: null },
    remarks: { type: String, trim: true, maxlength: 500 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

warehouseTransferSchema.index({ tenantId: 1, transferNumber: 1 }, { unique: true });
warehouseTransferSchema.index({ tenantId: 1, sourceWarehouse: 1, status: 1 });
warehouseTransferSchema.index({ tenantId: 1, destinationWarehouse: 1, status: 1 });

/** Units still on the truck: dispatched, but neither received nor recorded damaged. */
warehouseTransferSchema.methods.outstandingFor = function outstandingFor(line) {
  return line.dispatchedQuantity - line.receivedQuantity - line.damagedInTransitQuantity;
};

export const WarehouseTransfer = mongoose.model('WarehouseTransfer', warehouseTransferSchema);
export default WarehouseTransfer;

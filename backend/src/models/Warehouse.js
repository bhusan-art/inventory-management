import mongoose from 'mongoose';

const rackSchema = new mongoose.Schema(
  {
    _id: false,
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
    description: { type: String, trim: true, maxlength: 120 },
    shelves: [{ type: String, uppercase: true, trim: true, maxlength: 20 }],
  },
  { _id: false },
);

const warehouseSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },

    /**
     * TRANSIT is a system-managed pseudo-warehouse holding stock that has left
     * the source and not yet reached the destination. Without it, goods in a
     * truck vanish from the global count for the duration of the journey.
     * SCRAP is its equivalent for written-off stock: removed from saleable
     * inventory but still countable and auditable.
     */
    type: {
      type: String,
      enum: ['MAIN', 'BRANCH', 'SERVICE_CENTER', 'TRANSIT', 'SCRAP'],
      default: 'MAIN',
      index: true,
    },

    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 80 },
      state: { type: String, trim: true, maxlength: 80 },
      postalCode: { type: String, trim: true, maxlength: 12 },
      country: { type: String, trim: true, maxlength: 80, default: 'India' },
    },

    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    contactNumber: { type: String, trim: true, maxlength: 20 },

    racks: { type: [rackSchema], default: [] },

    /** System warehouses (TRANSIT, SCRAP) cannot be deleted or re-typed. */
    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

warehouseSchema.index({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
warehouseSchema.index({ tenantId: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
warehouseSchema.index({ tenantId: 1, type: 1, status: 1 });

export const Warehouse = mongoose.model('Warehouse', warehouseSchema);
export default Warehouse;

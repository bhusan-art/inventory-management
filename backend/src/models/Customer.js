import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 60 },
    line1: { type: String, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 80 },
    state: { type: String, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 12 },
    country: { type: String, trim: true, maxlength: 80, default: 'India' },
  },
  { _id: false },
);

const customerSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    customerName: { type: String, required: true, trim: true, maxlength: 200 },
    customerCode: { type: String, required: true, uppercase: true, trim: true, maxlength: 30 },
    companyName: { type: String, trim: true, maxlength: 200 },
    contactPerson: { type: String, trim: true, maxlength: 120 },

    // Restricted: VIEW_CONTACT_DETAILS.
    phone: { type: String, trim: true, maxlength: 20, select: false },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, select: false },

    billingAddress: { type: addressSchema, default: undefined },
    shippingAddresses: { type: [addressSchema], default: [] },

    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10 },

    /**
     * Material issued to your own project site is not a sale, but it still
     * leaves inventory and must stay traceable to a serial. Same document
     * flow, different classification — which keeps internal issues out of
     * customer sales reporting instead of quietly inflating it.
     */
    customerType: {
      type: String,
      enum: ['EXTERNAL', 'INTERNAL_DEPARTMENT', 'PROJECT_SITE'],
      default: 'EXTERNAL',
      index: true,
    },

    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'ON_HOLD'], default: 'ACTIVE', index: true },
    remarks: { type: String, trim: true, maxlength: 500 },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customerSchema.index({ tenantId: 1, customerCode: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
customerSchema.index({ tenantId: 1, customerType: 1, status: 1 });
customerSchema.index({ tenantId: 1, customerName: 'text', companyName: 'text' });

export const Customer = mongoose.model('Customer', customerSchema);
export default Customer;

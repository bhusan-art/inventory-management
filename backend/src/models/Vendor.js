import mongoose from 'mongoose';

/**
 * Vendor master.
 *
 * Carries no pricing, payment or balance data — this system does not track
 * money (ARCHITECTURE.md §0.1). Vendor performance is therefore measured in
 * delivery time and supply accuracy, which is what `leadTimeDays` is for.
 */
const vendorSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    vendorName: { type: String, required: true, trim: true, maxlength: 200 },
    vendorCode: { type: String, required: true, uppercase: true, trim: true, maxlength: 30 },
    contactPerson: { type: String, trim: true, maxlength: 120 },

    // Restricted: registry maps these to VIEW_CONTACT_DETAILS.
    phone: { type: String, trim: true, maxlength: 20, select: false },
    email: { type: String, trim: true, lowercase: true, maxlength: 160, select: false },

    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 80 },
      state: { type: String, trim: true, maxlength: 80 },
      postalCode: { type: String, trim: true, maxlength: 12 },
      country: { type: String, trim: true, maxlength: 80, default: 'India' },
    },

    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10 },

    /** Restricted: VIEW_VENDOR_BANK_DETAILS. Masked even for readers who hold it. */
    bankDetails: {
      type: {
        accountName: String,
        accountNumber: String,
        ifsc: String,
        bankName: String,
        branch: String,
      },
      select: false,
      default: undefined,
    },

    leadTimeDays: { type: Number, min: 0, max: 365, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE', 'BLACKLISTED'], default: 'ACTIVE', index: true },
    remarks: { type: String, trim: true, maxlength: 500 },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

vendorSchema.index({ tenantId: 1, vendorCode: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
vendorSchema.index({ tenantId: 1, status: 1 });
vendorSchema.index({ tenantId: 1, vendorName: 'text', contactPerson: 'text' });

export const Vendor = mongoose.model('Vendor', vendorSchema);
export default Vendor;

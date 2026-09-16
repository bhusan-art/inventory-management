import mongoose from 'mongoose';

/**
 * Tenant root.
 *
 * The system runs with exactly one company today. This model exists now, and
 * every tenant-scoped collection carries a `tenantId` pointing at it, because
 * retrofitting a tenant discriminator after the schemas have unique indexes,
 * production data and twenty services reading them is a rewrite. Adding it here
 * costs one field and one compound index per collection.
 *
 * There is deliberately no UI for creating companies — that is a Phase 13+
 * decision. What exists now is the enforcement path.
 */
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 20 },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10 },
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: { type: String, default: 'India' },
    },
    financialYearStartMonth: { type: Number, min: 1, max: 12, default: 4 }, // April
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },
  },
  { timestamps: true },
);

export const Company = mongoose.model('Company', companySchema);
export default Company;

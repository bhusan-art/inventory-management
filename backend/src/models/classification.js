import mongoose from 'mongoose';

/**
 * Category, Brand and Manufacturer are the same shape: a named, coded,
 * tenant-scoped lookup. One factory rather than three near-identical files —
 * if a rule changes (uniqueness, soft delete, status), it changes once.
 *
 * Subcategory is built separately below because it carries a parent.
 */
function classificationSchema(extra = {}, { uniqueName = true } = {}) {
  const schema = new mongoose.Schema(
    {
      tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
      name: { type: String, required: true, trim: true, maxlength: 120 },
      code: { type: String, required: true, uppercase: true, trim: true, maxlength: 30 },
      description: { type: String, trim: true, maxlength: 500 },
      status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },

      deletedAt: { type: Date, default: null },
      deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      ...extra,
    },
    { timestamps: true },
  );

  // Live records only, so a deleted record does not squat on its code forever.
  schema.index({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

  // Subcategory opts out: its names are unique per parent, not per tenant.
  // Declaring the global index and then adding a narrower one would not undo
  // it — Mongoose creates both, and the broader one wins.
  if (uniqueName) {
    schema.index({ tenantId: 1, name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
  }
  return schema;
}

export const Category = mongoose.model('Category', classificationSchema());
export const Brand = mongoose.model('Brand', classificationSchema());

export const Manufacturer = mongoose.model(
  'Manufacturer',
  classificationSchema({
    website: { type: String, trim: true, maxlength: 200 },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
  }),
);

const subcategorySchema = classificationSchema(
  { category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true } },
  { uniqueName: false },
);

/**
 * A subcategory name is unique within its parent, not globally — "Switches"
 * can legitimately exist under both Networking and Electrical.
 *
 * The factory's global {tenantId, name} unique index is therefore wrong here
 * and is replaced, not supplemented.
 */
subcategorySchema.index(
  { tenantId: 1, category: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const Subcategory = mongoose.model('Subcategory', subcategorySchema);

import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    productCode: { type: String, required: true, uppercase: true, trim: true, maxlength: 40 },
    sku: { type: String, required: true, uppercase: true, trim: true, maxlength: 40 },

    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', default: null },
    manufacturer: { type: mongoose.Schema.Types.ObjectId, ref: 'Manufacturer', default: null },

    modelNumber: { type: String, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 2000 },
    specifications: [{ _id: false, key: String, value: String }],

    unitOfMeasure: {
      type: String,
      enum: ['PCS', 'BOX', 'MTR', 'KG', 'SET', 'LTR', 'ROLL'],
      default: 'PCS',
    },

    /**
     * Immutable once stock has moved. Flipping a product from serialized to
     * non-serialized (or back) after units exist would orphan every serial
     * record and make the ledger unreconcilable. Enforced in productService.
     */
    productType: {
      type: String,
      enum: ['SERIALIZED', 'NON_SERIALIZED'],
      required: true,
      index: true,
    },

    trackingAttributes: {
      requiresImei: { type: Boolean, default: false },
      requiresMac: { type: Boolean, default: false },
      requiresAssetTag: { type: Boolean, default: false },
    },

    /**
     * Optional regex validating serials at the receiving desk.
     *
     * Catching a mistyped serial at the dock is trivial. Catching it after the
     * unit has reached a customer and a warranty claim arrives against a
     * serial that does not exist is not.
     */
    serialFormatPattern: { type: String, trim: true, maxlength: 200, default: null },

    minStockLevel: { type: Number, min: 0, default: 0 },
    reorderLevel: { type: Number, min: 0, default: 0 },
    reorderQuantity: { type: Number, min: 0, default: 0 },
    maxStockLevel: { type: Number, min: 0, default: 0 },

    warrantyMonths: { type: Number, min: 0, max: 600, default: 0 },
    shelfLifeDays: { type: Number, min: 0, default: null },
    hsnCode: { type: String, trim: true, maxlength: 12 },

    images: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Document' }],
    status: { type: String, enum: ['ACTIVE', 'DISCONTINUED', 'INACTIVE'], default: 'ACTIVE', index: true },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

productSchema.index({ tenantId: 1, sku: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
productSchema.index({ tenantId: 1, productCode: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
productSchema.index({ tenantId: 1, category: 1, status: 1 });
productSchema.index({ tenantId: 1, name: 'text', description: 'text', modelNumber: 'text' });

/** min ≤ reorder ≤ max, when the levels are actually in use. */
productSchema.pre('validate', function validateStockLevels(next) {
  const { minStockLevel: min, reorderLevel: reorder, maxStockLevel: max } = this;
  if (max > 0) {
    if (min > max) return next(new Error('minStockLevel cannot exceed maxStockLevel'));
    if (reorder > max) return next(new Error('reorderLevel cannot exceed maxStockLevel'));
  }
  if (reorder > 0 && min > reorder) {
    return next(new Error('minStockLevel cannot exceed reorderLevel'));
  }
  return next();
});

export const Product = mongoose.model('Product', productSchema);
export default Product;

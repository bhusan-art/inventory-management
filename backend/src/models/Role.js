import mongoose from 'mongoose';
import { unknownPermissions } from '../constants/permissions.js';

const roleSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 40 },
    description: { type: String, maxlength: 400 },

    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: (codes) => unknownPermissions(codes).length === 0,
        message: (props) => `Unknown permissions: ${unknownPermissions(props.value).join(', ')}`,
      },
    },

    /**
     * Privilege ceiling. A user may not create, edit or assign a role whose
     * rank is greater than or equal to their own. Without this, an Admin can
     * mint a role with MANAGE_SUPER_ADMIN and hand it to themselves.
     */
    rank: { type: Number, required: true, min: 0, max: 100 },

    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE' },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Uniqueness is per tenant and among live records only, so a deleted role does
// not squat on its code forever.
roleSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
roleSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

export const Role = mongoose.model('Role', roleSchema);
export default Role;

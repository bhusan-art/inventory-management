import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Cost 12 in every real environment; 4 under test.
 *
 * 12 is the figure that matters — it is what protects a stolen hash, and it is
 * deliberately slow. But the integration fixtures hash five passwords and
 * verify five more per test, so at cost 12 a 28-test file spent most of two
 * minutes on bcrypt alone. Long requests overlap more, and overlap is what
 * turns a latent race into a failure.
 *
 * Lowering it under test weakens nothing: the hashes are thrown away with the
 * database. The guard is that the override is keyed on NODE_ENV === 'test' and
 * nothing else, so there is no configuration anyone could set in production to
 * get a weak hash.
 */
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

const userSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },

    /**
     * Restricted (registry: User.phone → VIEW_CONTACT_DETAILS).
     * `select: false` is the first security layer: a developer who writes a new
     * endpoint and never reads the access-control docs ships one that omits
     * this field, rather than one that leaks it.
     */
    phone: { type: String, trim: true, maxlength: 20, select: false },

    passwordHash: { type: String, required: true, select: false },

    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true, index: true },

    /** Per-user overrides. Denies always win over grants and over the role. */
    permissionGrants: { type: [String], default: [] },
    permissionDenies: { type: [String], default: [] },

    /** Empty warehouseIds means "all warehouses in this tenant". */
    scope: {
      warehouseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' }],
    },

    department: { type: String, trim: true, maxlength: 80 },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_ACTIVATION'],
      default: 'ACTIVE',
      index: true,
    },

    /**
     * Warehouse devices get longer sessions. A picker re-authenticating with
     * gloves on, mid goods-receipt, is how bad data gets entered.
     */
    sessionProfile: { type: String, enum: ['STANDARD', 'KIOSK'], default: 'STANDARD' },

    /**
     * Bumped whenever anything that affects authorization changes: role,
     * permissions, scope, status, password. Every request compares the token's
     * copy against this, so a demoted user loses access on their next call
     * instead of when their 15-minute access token happens to expire.
     */
    tokenVersion: { type: Number, default: 0 },

    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },

    /** Reset tokens are stored hashed and single-use, same as refresh tokens. */
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

userSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) {
    throw new Error('passwordHash not selected — use the repository method that selects it');
  }
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export const User = mongoose.model('User', userSchema);
export default User;

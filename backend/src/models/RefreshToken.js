import mongoose from 'mongoose';
import crypto from 'node:crypto';

/**
 * Refresh tokens, stored hashed.
 *
 * The raw token never touches the database. If this collection is ever dumped,
 * the attacker has a list of SHA-256 digests and no sessions.
 *
 * `familyId` implements rotation with reuse detection: each refresh issues a
 * new token in the same family and marks the old one used. Presenting an
 * already-used token means it was captured, so the whole family is revoked and
 * the user's tokenVersion is bumped, killing every outstanding access token.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },

    issuedAt: { type: Date, required: true, default: Date.now },
    // TTL index: expired tokens are removed by MongoDB, so this collection does
    // not grow without bound and a stale token cannot be replayed after expiry.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },

    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    replacedBy: { type: String, default: null },

    ip: String,
    userAgent: String,
    sessionProfile: { type: String, enum: ['STANDARD', 'KIOSK'], default: 'STANDARD' },
  },
  { timestamps: true },
);

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export default RefreshToken;

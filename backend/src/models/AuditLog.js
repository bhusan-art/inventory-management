import mongoose from 'mongoose';

/**
 * Append-only audit trail.
 *
 * Write hooks below make update and delete impossible at the ODM level. An
 * audit log that can be edited by the application that writes it is not an
 * audit log.
 */
const auditLogSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: String,
    actorRole: String,
    actorIp: String,
    userAgent: String,
    requestId: String,

    action: { type: String, required: true, index: true },
    module: { type: String, required: true, index: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    recordLabel: String,

    /**
     * Values for restricted fields are stored redacted. Otherwise the audit
     * log becomes the back door around the serializer: deny someone a phone
     * number on the user endpoint, then let them read it from a change diff.
     */
    changes: [
      {
        _id: false,
        field: String,
        before: mongoose.Schema.Types.Mixed,
        after: mongoose.Schema.Types.Mixed,
        redacted: { type: Boolean, default: false },
      },
    ],

    severity: {
      type: String,
      enum: ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'],
      default: 'INFO',
      index: true,
    },
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, module: 1, recordId: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, actor: 1, createdAt: -1 });
auditLogSchema.index({ tenantId: 1, severity: 1, createdAt: -1 });

const immutable = function immutable(next) {
  next(new Error('Audit logs are append-only and cannot be modified or deleted.'));
};

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditLogSchema.pre(op, immutable);
}

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;

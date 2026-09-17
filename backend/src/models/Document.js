import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    storageKey: { type: String, required: true, unique: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    /** Deduplicates uploads and detects tampering. */
    checksumSha256: { type: String, required: true, index: true },

    module: { type: String, required: true, index: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    documentType: { type: String, trim: true, maxlength: 60, default: null },

    /** Gated behind VIEW_RESTRICTED_DOCUMENTS at download. */
    isRestricted: { type: Boolean, default: false },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

documentSchema.index({ tenantId: 1, module: 1, recordId: 1 });

export const Document = mongoose.model('Document', documentSchema);
export default Document;

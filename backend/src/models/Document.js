import mongoose from 'mongoose';
import { DOCUMENT_ENTITIES, DOCUMENT_CATEGORIES, ALLOWED_MIME_TYPES } from '../constants/documents.js';

/**
 * A file attached to a record.
 *
 * Two names, deliberately:
 *
 *   originalName  what the uploader called it. DISPLAY ONLY. Never touches a
 *                 filesystem path, because it is attacker-controlled — the
 *                 classic payload being "../../etc/passwd" or a 300-character
 *                 name that breaks whatever concatenates it.
 *   storageKey    what we called it: a random name we generated, relative to
 *                 the storage root, with the extension derived from the
 *                 VERIFIED type rather than from anything the client said.
 *
 * Keeping them apart is what makes path traversal structurally impossible
 * rather than something a validator has to catch.
 */
const documentSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },

    entityType: { type: String, enum: DOCUMENT_ENTITIES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

    category: { type: String, enum: DOCUMENT_CATEGORIES, default: 'OTHER' },
    title: { type: String, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000 },

    originalName: { type: String, required: true, maxlength: 400 },
    storageKey: { type: String, required: true },

    mimeType: { type: String, enum: ALLOWED_MIME_TYPES, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },

    /**
     * SHA-256 of the contents.
     *
     * Earns its place twice: it detects the same file uploaded twice, and it
     * detects a stored file that has changed underneath us, which is the only
     * way to notice disk corruption or tampering after the fact.
     */
    checksum: { type: String, required: true, index: true },

    /**
     * Restricted documents need VIEW_RESTRICTED_DOCUMENTS to download.
     *
     * The flag is on the document and not the category, because sensitivity is
     * a property of the particular file. One inspection report is routine;
     * another names an employee.
     */
    isRestricted: { type: Boolean, default: false, index: true },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// The query every document list makes.
documentSchema.index({ tenantId: 1, entityType: 1, entityId: 1, deletedAt: 1 });
// Duplicate detection within a tenant.
documentSchema.index({ tenantId: 1, checksum: 1 });

export const DocumentFile = mongoose.model('Document', documentSchema);
export default DocumentFile;

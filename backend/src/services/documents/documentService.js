import mongoose from 'mongoose';
import { DocumentFile } from '../../models/Document.js';
import { writeAudit } from '../shared/auditService.js';
import * as storage from './storage.js';
import { toObjectId } from '../../utils/objectId.js';
import {
  ENTITY_MODEL, ENTITY_VIEW_PERMISSION, ALLOWED_TYPES, MAX_FILE_BYTES,
} from '../../constants/documents.js';
import { NotFoundError, DomainError, ForbiddenError } from '../../utils/errors.js';

/**
 * Confirms the parent record exists, belongs to this tenant, and that the
 * actor is entitled to see it.
 *
 * This is the check that stops documents becoming a side door. Without it,
 * anyone holding CREATE_DOCUMENT could attach a file to a purchase order they
 * cannot read, then read it back — and the file list would tell them which
 * records exist. A document is exactly as confidential as the thing it hangs
 * on, so the permission comes from the parent, not from the document.
 */
async function assertParentVisible(actor, entityType, entityId) {
  const modelName = ENTITY_MODEL[entityType];
  if (!modelName) throw new DomainError(`Unknown entity type ${entityType}`, 'UNKNOWN_ENTITY_TYPE');

  const required = ENTITY_VIEW_PERMISSION[entityType];
  if (required && !actor.permissions.has(required)) {
    throw new ForbiddenError(
      `You do not have permission to view the record this document belongs to`,
      'PARENT_ACCESS_DENIED',
    );
  }

  const Model = mongoose.model(modelName);
  const parent = await Model.findOne({ _id: entityId, tenantId: actor.tenantId });

  // 404, not 403: confirming a record exists in another tenant is itself a
  // disclosure (ARCHITECTURE.md §2.10).
  if (!parent) throw new NotFoundError('The record this document belongs to was not found');

  return parent;
}

export async function listDocuments(actor, { entityType, entityId }) {
  await assertParentVisible(actor, entityType, entityId);

  const docs = await DocumentFile.find({
    tenantId: actor.tenantId, entityType, entityId, deletedAt: null,
  })
    .populate('uploadedBy', 'fullName')
    .sort({ createdAt: -1 });

  // Restricted documents are LISTED but not downloadable without the
  // permission. Hiding them entirely would mean someone could not tell a
  // document was missing from a record they are auditing; the filename and
  // uploader are not the sensitive part, the contents are.
  return docs.map((d) => ({
    doc: d,
    downloadable: !d.isRestricted || actor.permissions.has('VIEW_RESTRICTED_DOCUMENTS'),
  }));
}

/**
 * Stores one uploaded file.
 *
 * Order matters. Every cheap rejection happens before anything touches disk,
 * and the bytes are verified against the declared type before they are
 * written — so a file that lied about what it is never exists on our
 * filesystem at all.
 */
export async function uploadDocument(actor, { entityType, entityId }, file, meta = {}) {
  await assertParentVisible(actor, entityType, entityId);

  if (!file?.buffer?.length) {
    throw new DomainError('No file received', 'FILE_REQUIRED');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new DomainError(
      `Files must be ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB or smaller`,
      'FILE_TOO_LARGE',
    );
  }
  if (!ALLOWED_TYPES[file.mimetype]) {
    throw new DomainError(
      `${file.mimetype} files are not accepted`,
      'FILE_TYPE_NOT_ALLOWED',
    );
  }

  // Throws if the contents disagree with the declared type.
  storage.verifyMagicBytes(file.buffer, file.mimetype);

  const checksum = storage.checksumOf(file.buffer);

  // The same bytes already attached to the same record is a double-submit, not
  // a second document. Returned rather than refused: the caller got what they
  // wanted either way.
  const duplicate = await DocumentFile.findOne({
    tenantId: actor.tenantId, entityType, entityId, checksum, deletedAt: null,
  });
  if (duplicate) return { document: duplicate, duplicate: true };

  const storageKey = await storage.store(file.buffer, {
    tenantId: actor.tenantId,
    mimeType: file.mimetype,
  });

  let document;
  try {
    document = await DocumentFile.create({
      tenantId: actor.tenantId,
      entityType,
      entityId,
      category: meta.category ?? 'OTHER',
      title: meta.title ?? null,
      description: meta.description ?? null,
      // Kept for display only. It never reaches a filesystem path.
      originalName: file.originalname,
      storageKey,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      checksum,
      isRestricted: meta.isRestricted ?? false,
      uploadedBy: actor.id,
    });
  } catch (err) {
    // Never leave a file on disk with no record pointing at it: that is an
    // orphan nobody will ever find, delete or audit.
    await storage.remove(storageKey);
    throw err;
  }

  await writeAudit({
    action: 'DOCUMENT_UPLOADED', module: 'Document', recordId: document._id,
    recordLabel: file.originalname, severity: meta.isRestricted ? 'CRITICAL' : 'NOTICE',
    tenantId: actor.tenantId,
    metadata: {
      entityType, entityId: String(entityId),
      sizeBytes: file.size, mimeType: file.mimetype,
      isRestricted: Boolean(meta.isRestricted),
    },
  });

  return { document, duplicate: false };
}

/**
 * Fetches a document for download, with every gate applied.
 *
 * The checksum is re-verified on the way out. If the stored bytes no longer
 * hash to what we recorded, something changed them — disk corruption, or
 * someone with filesystem access — and serving them anyway would mean handing
 * a user a file we can no longer vouch for.
 */
export async function getForDownload(actor, id) {
  const document = await DocumentFile.findOne({
    _id: id, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!document) throw new NotFoundError('Document not found');

  // The parent's permission governs, every time — not just at upload.
  await assertParentVisible(actor, document.entityType, document.entityId);

  if (document.isRestricted && !actor.permissions.has('VIEW_RESTRICTED_DOCUMENTS')) {
    await writeAudit({
      action: 'RESTRICTED_DOCUMENT_DENIED', module: 'Document', recordId: document._id,
      recordLabel: document.originalName, severity: 'WARNING', tenantId: actor.tenantId,
    });
    throw new ForbiddenError(
      'This document is restricted',
      'RESTRICTED_DOCUMENT_ACCESS_DENIED',
    );
  }

  if (!(await storage.exists(document.storageKey))) {
    throw new NotFoundError('The stored file is missing', 'FILE_MISSING_FROM_STORAGE');
  }

  const buffer = await storage.read(document.storageKey);
  const actual = storage.checksumOf(buffer);

  if (actual !== document.checksum) {
    await writeAudit({
      action: 'DOCUMENT_CHECKSUM_MISMATCH', module: 'Document', recordId: document._id,
      recordLabel: document.originalName, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: { expected: document.checksum, actual },
    });
    throw new DomainError(
      'This file has changed since it was uploaded and cannot be served',
      'DOCUMENT_CORRUPTED',
    );
  }

  // Every download of a restricted document is recorded. That is the point of
  // marking it: not only that access is controlled, but that it is accounted
  // for afterwards.
  if (document.isRestricted) {
    await writeAudit({
      action: 'RESTRICTED_DOCUMENT_DOWNLOADED', module: 'Document', recordId: document._id,
      recordLabel: document.originalName, severity: 'CRITICAL', tenantId: actor.tenantId,
    });
  }

  return { document, buffer };
}

/**
 * Soft-deletes the record and keeps the bytes.
 *
 * The file stays on disk deliberately. A document attached to a goods receipt
 * is evidence, and "delete" by a user is a filing decision rather than
 * permission to destroy the artefact. Purging orphaned files is a separate,
 * deliberate operation — not a side effect of someone tidying a screen.
 */
export async function deleteDocument(actor, id, reason) {
  const document = await DocumentFile.findOne({
    _id: id, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!document) throw new NotFoundError('Document not found');

  await assertParentVisible(actor, document.entityType, document.entityId);

  document.deletedAt = new Date();
  document.deletedBy = actor.id;
  await document.save();

  await writeAudit({
    action: 'DOCUMENT_DELETED', module: 'Document', recordId: document._id,
    recordLabel: document.originalName, severity: 'CRITICAL', tenantId: actor.tenantId,
    metadata: { reason: reason ?? null, bytesRetained: true },
  });

  return document;
}

/** Storage used per tenant, for the dashboard and for noticing runaway growth. */
export async function storageSummary(actor) {
  // Cast for the pipeline — `$match` does not get schema casting.
  const tenant = toObjectId(actor.tenantId);

  const [row] = await DocumentFile.aggregate([
    { $match: { tenantId: tenant, deletedAt: null } },
    {
      $group: {
        _id: null,
        documents: { $sum: 1 },
        bytes: { $sum: '$sizeBytes' },
        restricted: { $sum: { $cond: ['$isRestricted', 1, 0] } },
      },
    },
  ]);

  const byCategory = await DocumentFile.aggregate([
    { $match: { tenantId: tenant, deletedAt: null } },
    { $group: { _id: '$category', count: { $sum: 1 }, bytes: { $sum: '$sizeBytes' } } },
    { $sort: { count: -1 } },
  ]);

  return {
    documents: row?.documents ?? 0,
    bytes: row?.bytes ?? 0,
    restricted: row?.restricted ?? 0,
    byCategory: byCategory.map((c) => ({ category: c._id, count: c.count, bytes: c.bytes })),
  };
}

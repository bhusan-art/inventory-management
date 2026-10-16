import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as documentService from '../services/documents/documentService.js';
import { INLINE_SAFE_TYPES } from '../constants/documents.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? { id: String(v._id), name: v.fullName ?? v.name ?? null }
  : v ? String(v) : null);

export function serializeDocument(d, { downloadable = true } = {}) {
  if (!d) return null;
  const o = d.toObject ? d.toObject() : d;

  return {
    id: String(o._id),
    entityType: o.entityType,
    entityId: String(o.entityId),
    category: o.category,
    title: o.title ?? null,
    description: o.description ?? null,
    originalName: o.originalName,
    mimeType: o.mimeType,
    sizeBytes: o.sizeBytes,
    // First 12 characters are plenty to compare two files by eye.
    checksum: o.checksum?.slice(0, 12) ?? null,
    isRestricted: o.isRestricted,
    // Says whether THIS actor may download it, so the UI can show the row
    // without offering a button that would 403.
    downloadable,
    uploadedBy: ref(o.uploadedBy),
    createdAt: o.createdAt,
    // The storage key is never serialized. It is an internal filesystem
    // reference and nothing outside the server has any use for it.
  };
}

export const listDocuments = asyncHandler(async (req, res) => {
  const rows = await documentService.listDocuments(req.actor, {
    entityType: req.query.entityType,
    entityId: req.query.entityId,
  });

  return ok(res, { data: rows.map(({ doc, downloadable }) => serializeDocument(doc, { downloadable })) });
});

export const uploadDocument = asyncHandler(async (req, res) => {
  const { document, duplicate } = await documentService.uploadDocument(
    req.actor,
    { entityType: req.body.entityType, entityId: req.body.entityId },
    req.file,
    {
      category: req.body.category,
      title: req.body.title,
      description: req.body.description,
      // Multipart form fields arrive as strings, so 'false' would be truthy.
      isRestricted: req.body.isRestricted === 'true' || req.body.isRestricted === true,
    },
  );

  const body = { message: duplicate ? 'This file is already attached' : 'Document uploaded', data: serializeDocument(document) };
  return duplicate ? ok(res, body) : created(res, body);
});

/**
 * Streams the file back.
 *
 * The headers are the security-relevant part:
 *
 *   Content-Disposition  `attachment` for anything not provably safe to render.
 *                        A file the browser renders inline executes in OUR
 *                        origin, which turns an upload into stored XSS.
 *   X-Content-Type-Options: nosniff
 *                        Stops the browser second-guessing the type we set and
 *                        deciding a .txt is really HTML.
 *   Content-Security-Policy
 *                        A sandbox even for the inline-safe types, so a PDF
 *                        with an embedded script has nothing to reach.
 *
 * The filename is quoted and stripped of quotes and control characters: an
 * unescaped name is a header-injection vector.
 */
export const downloadDocument = asyncHandler(async (req, res) => {
  const { document, buffer } = await documentService.getForDownload(req.actor, req.params.id);

  const inline = INLINE_SAFE_TYPES.includes(document.mimeType);
  const safeName = document.originalName.replace(/[\r\n"\\]/g, '_').slice(0, 200);

  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
  );
  // A document is immutable once stored — the checksum guarantees it — so it
  // is safely cacheable, but privately: it is somebody's commercial paperwork.
  res.setHeader('Cache-Control', 'private, max-age=3600');

  return res.send(buffer);
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const document = await documentService.deleteDocument(req.actor, req.params.id, req.body?.reason);
  return ok(res, {
    message: 'Document removed from the record. The file itself is retained.',
    data: serializeDocument(document),
  });
});

export const storageSummary = asyncHandler(async (req, res) => {
  const summary = await documentService.storageSummary(req.actor);
  return ok(res, { data: summary });
});

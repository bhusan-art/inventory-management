import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import * as auditQuery from '../services/audit/auditQueryService.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? { id: String(v._id), name: v.fullName ?? null }
  : v ? String(v) : null);

export function serializeAuditLog(a) {
  return {
    id: String(a._id),
    action: a.action,
    module: a.module,
    severity: a.severity,
    recordId: a.recordId ? String(a.recordId) : null,
    recordLabel: a.recordLabel ?? null,
    actor: ref(a.actor),
    // Kept even when the user record is gone: the log records what was true at
    // the time, and a deleted user must not erase their own trail.
    actorName: a.actorName ?? null,
    actorRole: a.actorRole ?? null,
    actorIp: a.actorIp ?? null,
    requestId: a.requestId ?? null,
    changes: (a.changes ?? []).map((c) => ({
      field: c.field,
      // Restricted values were redacted at write time, so the log can never
      // become the back door around the serializer.
      before: c.redacted ? null : c.before,
      after: c.redacted ? null : c.after,
      redacted: Boolean(c.redacted),
    })),
    metadata: a.metadata ?? null,
    createdAt: a.createdAt,
  };
}

export const listAuditLogs = asyncHandler(async (req, res) => {
  const { items, meta } = await auditQuery.listAuditLogs(req.actor, req.query);
  return ok(res, { data: items.map(serializeAuditLog), meta });
});

export const recordHistory = asyncHandler(async (req, res) => {
  const items = await auditQuery.recordHistory(req.actor, req.params.module, req.params.recordId);
  return ok(res, { data: items.map(serializeAuditLog) });
});

export const auditVocabulary = asyncHandler(async (req, res) => {
  return ok(res, { data: await auditQuery.auditVocabulary(req.actor) });
});

export const auditSummary = asyncHandler(async (req, res) => {
  const summary = await auditQuery.auditSummary(req.actor, { days: Number(req.query.days) || 7 });
  return ok(res, {
    data: { ...summary, criticalRecent: summary.criticalRecent.map(serializeAuditLog) },
  });
});

import { AuditLog } from '../../models/AuditLog.js';
import { restrictedFieldsFor } from '../../constants/restrictedFields.js';
import { getContext } from '../../middleware/requestContext.js';
import logger from '../../config/logger.js';

/**
 * Audit writer.
 *
 * Reads the actor, IP and request id from the ambient request context, so
 * services call `writeAudit({ action, module, ... })` without threading four
 * more arguments through every signature.
 *
 * Failures are logged, never thrown. An audit sink that is briefly unavailable
 * must not roll back a stock movement that already happened; the correct
 * response is an alert, not data loss.
 */
export async function writeAudit({
  action,
  module,
  recordId = null,
  recordLabel = null,
  changes = [],
  severity = 'INFO',
  metadata = null,
  tenantId = null,
  session = null,
} = {}) {
  try {
    const ctx = getContext();
    const actor = ctx?.actor ?? null;

    const doc = {
      tenantId: tenantId ?? actor?.tenantId ?? null,
      actor: actor?.id ?? null,
      actorName: actor?.fullName ?? null,
      actorRole: actor?.roleCode ?? null,
      actorIp: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
      action,
      module,
      recordId,
      recordLabel,
      changes: redactChanges(module, changes),
      severity,
      metadata,
    };

    if (!doc.tenantId) {
      logger.warn({ action, module }, 'Audit entry skipped: no tenant in context');
      return null;
    }

    const created = await AuditLog.create(session ? [doc] : doc, session ? { session } : undefined);
    return Array.isArray(created) ? created[0] : created;
  } catch (err) {
    logger.error({ err, action, module }, 'Failed to write audit log');
    return null;
  }
}

/**
 * Replaces before/after values for restricted fields with a marker.
 * Without this the audit trail is a bypass: deny a role the phone number on
 * the user endpoint, then let it read the value from a change diff.
 */
export function redactChanges(modelName, changes = []) {
  const restricted = restrictedFieldsFor(modelName);
  return changes.map((c) => {
    const root = String(c.field ?? '').split('.')[0];
    if (restricted[root]) {
      return { field: c.field, before: '[restricted]', after: '[restricted]', redacted: true };
    }
    return { ...c, redacted: false };
  });
}

/** Field-level diff between two plain objects, ignoring unchanged values. */
export function diff(before = {}, after = {}, fields = null) {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = [];
  for (const field of keys) {
    const b = before[field];
    const a = after[field];
    if (JSON.stringify(b) !== JSON.stringify(a)) changes.push({ field, before: b ?? null, after: a ?? null });
  }
  return changes;
}

export default writeAudit;

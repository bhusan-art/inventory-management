import { AuditLog } from '../../models/AuditLog.js';
import { toObjectId } from '../../utils/objectId.js';
import { escapeRegex } from '../shared/crudFactory.js';
import { NotFoundError } from '../../utils/errors.js';

/**
 * Reading the audit trail.
 *
 * The log has been written since Phase 1 and never read — which is the normal
 * fate of an audit log, and the reason this phase exists. A trail nobody can
 * query is a compliance artefact rather than a tool.
 *
 * Reads only. There is no update or delete here and there cannot be: the model
 * refuses both at the ODM level. An audit log the application can edit is not
 * an audit log.
 */
export async function listAuditLogs(actor, query) {
  const filter = { tenantId: actor.tenantId };

  if (query.action) filter.action = query.action;
  if (query.module) filter.module = query.module;
  if (query.severity) filter.severity = query.severity;
  if (query.actor) filter.actor = query.actor;
  if (query.recordId) filter.recordId = query.recordId;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  if (query.search) {
    const rx = { $regex: escapeRegex(String(query.search)), $options: 'i' };
    filter.$or = [{ recordLabel: rx }, { actorName: rx }, { action: rx }];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 50);

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('actor', 'fullName email')
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

/** One record's complete history — the question an auditor actually asks. */
export async function recordHistory(actor, module, recordId) {
  const items = await AuditLog.find({
    tenantId: actor.tenantId, module, recordId,
  })
    .sort({ createdAt: 1 })
    .populate('actor', 'fullName')
    .lean();

  if (items.length === 0) {
    throw new NotFoundError('No audit history for that record', 'NO_AUDIT_HISTORY');
  }
  return items;
}

/**
 * The distinct actions and modules present, for populating filter dropdowns.
 *
 * Derived from the data rather than from a hard-coded list, so a new action
 * added by a future phase appears in the filter without anyone maintaining a
 * second copy of the vocabulary.
 */
export async function auditVocabulary(actor) {
  const tenant = toObjectId(actor.tenantId);

  const [actions, modules] = await Promise.all([
    AuditLog.distinct('action', { tenantId: tenant }),
    AuditLog.distinct('module', { tenantId: tenant }),
  ]);

  return {
    actions: actions.sort(),
    modules: modules.sort(),
    /**
     * Severities come from the SCHEMA, not from `distinct`.
     *
     * Unlike actions and modules, the set is fixed and known in advance, and a
     * severity with no rows yet must still be selectable — otherwise the
     * CRITICAL filter is missing from a healthy system and appears only once
     * something has gone wrong, which is the worst possible moment to discover
     * a new control.
     *
     * Reading the enum rather than listing them keeps one source: the first
     * version of the audit page hard-coded three of the four, so every NOTICE
     * entry — 29 call sites, a third of the trail — rendered as "Info" and
     * could not be filtered for at all.
     */
    severities: AuditLog.schema.path('severity').enumValues,
  };
}

/**
 * Activity summary — who did what, and where the critical events are.
 *
 * Counts only; no payloads. The point is to spot a pattern worth opening, not
 * to be a second way of reading the records themselves.
 */
export async function auditSummary(actor, { days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const tenant = toObjectId(actor.tenantId);

  const [bySeverity, byModule, byActor, criticalRecent] = await Promise.all([
    AuditLog.aggregate([
      { $match: { tenantId: tenant, createdAt: { $gte: since } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    AuditLog.aggregate([
      { $match: { tenantId: tenant, createdAt: { $gte: since } } },
      { $group: { _id: '$module', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    AuditLog.aggregate([
      { $match: { tenantId: tenant, createdAt: { $gte: since }, actor: { $ne: null } } },
      { $group: { _id: { actor: '$actor', name: '$actorName' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    AuditLog.find({ tenantId: tenant, severity: 'CRITICAL', createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('actor', 'fullName')
      .lean(),
  ]);

  return {
    since,
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r._id, r.count])),
    byModule: byModule.map((r) => ({ module: r._id, count: r.count })),
    byActor: byActor.map((r) => ({ actor: String(r._id.actor), name: r._id.name, count: r.count })),
    criticalRecent,
  };
}

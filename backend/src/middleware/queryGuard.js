import { permissionForQueryKey } from '../constants/restrictedFields.js';
import { ForbiddenError } from '../utils/errors.js';
import { writeAudit } from '../services/shared/auditService.js';

/**
 * Query guard — ARCHITECTURE.md §5, layer 4.
 *
 * Hiding a field in the response is not enough. `?sort=phone` orders records by
 * a value the caller cannot see, and `?filter[phone][regex]=^98` tests it one
 * prefix at a time. Both extract the field without it ever appearing in a body.
 *
 * Denials are rejected loudly and audited, not silently dropped: a silent drop
 * makes a probe indistinguishable from a legitimate empty result, which hides
 * exactly the behaviour worth noticing.
 */
function collectKeys(query = {}) {
  const keys = [];

  if (query.sort) {
    String(query.sort)
      .split(',')
      .forEach((part) => keys.push(part.split(':')[0]));
  }

  if (query.filter && typeof query.filter === 'object') {
    keys.push(...Object.keys(query.filter));
  }

  if (query.groupBy) keys.push(...String(query.groupBy).split(','));
  if (query.fields) keys.push(...String(query.fields).split(','));
  if (query.searchFields) keys.push(...String(query.searchFields).split(','));

  return keys.map((k) => k.trim()).filter(Boolean);
}

export function queryGuard(modelName) {
  // `async` so the audit write below can be awaited. It was a floating
  // promise: nothing held it, so a failed write vanished silently and an
  // unhandled rejection could outlive the request — and a probe at a
  // restricted field is precisely the event worth having on record.
  return async function guard(req, res, next) {
    const permissions = req.actor?.permissions ?? new Set();
    const denied = [];

    for (const key of collectKeys(req.query)) {
      const required = permissionForQueryKey(modelName, key);
      if (required && !permissions.has(required)) denied.push({ key, required });
    }

    if (denied.length === 0) return next();

    await writeAudit({
      action: 'RESTRICTED_FIELD_QUERY_DENIED',
      module: modelName.toUpperCase(),
      severity: 'WARNING',
      metadata: { path: req.originalUrl, fields: denied.map((d) => d.key) },
    });

    return next(
      new ForbiddenError(
        'You do not have permission to sort or filter by this field',
        'RESTRICTED_FIELD_ACCESS_DENIED',
        denied.map((d) => ({ code: 'RESTRICTED_FIELD_ACCESS_DENIED', field: d.key })),
      ),
    );
  };
}

export default queryGuard;

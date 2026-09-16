/**
 * Restricted-field registry — ARCHITECTURE.md §5, layer 2.
 *
 * Maps model → field path → the permission required to read it. Consumed by
 * the repository (which decides what to select), the serializer (which decides
 * what to emit), the query guard (which decides what may be sorted or filtered
 * on) and the export builder.
 *
 * One file, five consumers. The alternative — each consumer keeping its own
 * idea of what is sensitive — is how these systems leak: the API hides a field
 * correctly for two years and then a new CSV export quietly includes it.
 *
 * A CI test (tests/unit/restrictedFields.test.js) asserts every path here
 * exists on its schema and is declared `select: false`, so the registry cannot
 * drift away from the models.
 */
import { PERMISSIONS as P } from './permissions.js';

export const RESTRICTED_FIELDS = Object.freeze({
  User: {
    phone: P.VIEW_CONTACT_DETAILS,
  },
  Vendor: {
    phone: P.VIEW_CONTACT_DETAILS,
    email: P.VIEW_CONTACT_DETAILS,
    // Even holders of this permission see only the last four digits on list
    // and detail views — see maskBankDetails in master.serializer.js.
    bankDetails: P.VIEW_VENDOR_BANK_DETAILS,
  },
  Customer: {
    phone: P.VIEW_CONTACT_DETAILS,
    email: P.VIEW_CONTACT_DETAILS,
  },
});

/** @returns {Record<string,string>} field → required permission, for one model */
export function restrictedFieldsFor(modelName) {
  return RESTRICTED_FIELDS[modelName] ?? {};
}

/** Field paths on `modelName` that `permissions` is allowed to read. */
export function permittedRestrictedFields(modelName, permissions) {
  const map = restrictedFieldsFor(modelName);
  return Object.entries(map)
    .filter(([, required]) => permissions.has(required))
    .map(([field]) => field);
}

/** Field paths on `modelName` that `permissions` may NOT read. */
export function deniedRestrictedFields(modelName, permissions) {
  const map = restrictedFieldsFor(modelName);
  return Object.entries(map)
    .filter(([, required]) => !permissions.has(required))
    .map(([field]) => field);
}

/**
 * Resolves a query key (`phone`, `bankDetails.ifsc`, `-phone`) to the
 * permission it requires, or null if the field is not restricted.
 * Dotted paths resolve against their root so `bankDetails.ifsc` is covered by
 * the rule on `bankDetails`.
 */
export function permissionForQueryKey(modelName, key) {
  const map = restrictedFieldsFor(modelName);
  const clean = String(key).replace(/^[-+]/, '');
  if (map[clean]) return map[clean];
  const root = clean.split('.')[0];
  return map[root] ?? null;
}

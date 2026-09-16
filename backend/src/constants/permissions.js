/**
 * The permission catalogue. Single source of truth.
 *
 * Nothing in the system may check a permission string that is not declared
 * here — `assertKnownPermission` is called by the role validator and by the
 * route-mounting helper, so a typo in a route definition fails at boot rather
 * than silently granting access to everyone.
 */

const MODULES = [
  'PRODUCT', 'CATEGORY', 'VENDOR', 'CUSTOMER', 'PURCHASE_ORDER', 'GRN',
  'INVENTORY', 'WAREHOUSE', 'TRANSFER', 'SERIAL', 'SALES_ORDER',
  'DISPATCH_NOTE', 'WARRANTY', 'SERVICE_REQUEST', 'RETURN', 'DOCUMENT',
  'USER', 'ROLE', 'SETTING',
];

const CRUD = ['VIEW', 'CREATE', 'UPDATE', 'DELETE'];

/** Generated CRUD permissions: VIEW_PRODUCT, CREATE_PRODUCT, ... */
const crudPermissions = MODULES.flatMap((module) =>
  CRUD.map((verb) => ({
    code: `${verb}_${module}`,
    module,
    label: `${verb[0]}${verb.slice(1).toLowerCase()} ${module.replace(/_/g, ' ').toLowerCase()}`,
    restricted: false,
  })),
);

/** Operations that are not CRUD on a record — they change its state or move stock. */
const actionPermissions = [
  ['APPROVE_PURCHASE_ORDER', 'PURCHASE_ORDER', 'Approve a purchase order'],
  ['CLOSE_PURCHASE_ORDER', 'PURCHASE_ORDER', 'Short-close a purchase order'],
  ['POST_GRN', 'GRN', 'Post a GRN — writes inventory, irreversible'],
  ['CANCEL_GRN', 'GRN', 'Cancel a posted GRN via compensating entries'],
  ['ADJUST_INVENTORY', 'INVENTORY', 'Adjust stock within the configured threshold'],
  ['ADJUST_INVENTORY_UNLIMITED', 'INVENTORY', 'Adjust stock with no quantity ceiling'],
  ['RECONCILE_INVENTORY', 'INVENTORY', 'Run ledger reconciliation'],
  ['APPROVE_TRANSFER', 'TRANSFER', 'Approve a warehouse transfer'],
  ['DISPATCH_TRANSFER', 'TRANSFER', 'Dispatch an approved transfer'],
  ['RECEIVE_TRANSFER', 'TRANSFER', 'Receive a transfer at destination'],
  ['OVERRIDE_SERIAL_STATUS', 'SERIAL', 'Force a serial number status change'],
  ['CONFIRM_SALES_ORDER', 'SALES_ORDER', 'Confirm an order and reserve stock'],
  ['CREATE_DISPATCH', 'DISPATCH_NOTE', 'Dispatch goods to a customer'],
  ['CANCEL_DISPATCH', 'DISPATCH_NOTE', 'Cancel a dispatch note'],
  ['VOID_WARRANTY', 'WARRANTY', 'Void or amend a warranty'],
  ['ASSIGN_SERVICE_REQUEST', 'SERVICE_REQUEST', 'Assign a ticket to an engineer'],
  ['WORK_SERVICE_REQUEST', 'SERVICE_REQUEST', 'Progress and close a ticket'],
  ['APPROVE_RETURN', 'RETURN', 'Approve a return'],
  ['SET_DISPOSITION', 'RETURN', 'Decide what happens to returned stock'],
  ['EXPORT_DATA', 'REPORT', 'Export report data'],
  ['VIEW_REPORTS', 'REPORT', 'View operational reports'],
  ['VIEW_AUDIT_LOGS', 'AUDIT', 'Read the audit trail'],
  ['MANAGE_SUPER_ADMIN', 'USER', 'Create or modify Admin and Super Admin users'],
].map(([code, module, label]) => ({ code, module, label, restricted: false }));

/**
 * Permissions that unlock individual fields rather than whole operations.
 * These are the ones the serializer and query guard consult.
 */
const restrictedFieldPermissions = [
  ['VIEW_CONTACT_DETAILS', 'CONTACT', 'See phone numbers and email addresses'],
  ['VIEW_VENDOR_BANK_DETAILS', 'VENDOR', 'See unmasked vendor bank details'],
  ['VIEW_RESTRICTED_DOCUMENTS', 'DOCUMENT', 'Download documents marked restricted'],
].map(([code, module, label]) => ({ code, module, label, restricted: true }));

export const PERMISSION_DEFINITIONS = [
  ...crudPermissions,
  ...actionPermissions,
  ...restrictedFieldPermissions,
];

export const PERMISSIONS = Object.freeze(
  Object.fromEntries(PERMISSION_DEFINITIONS.map((p) => [p.code, p.code])),
);

export const ALL_PERMISSION_CODES = Object.freeze(PERMISSION_DEFINITIONS.map((p) => p.code));

const codeSet = new Set(ALL_PERMISSION_CODES);

export function isKnownPermission(code) {
  return codeSet.has(code);
}

/**
 * Fails loudly at module load / boot time rather than at request time.
 * A route that guards on a misspelled permission would otherwise be
 * unreachable by everyone, or — worse, if the check were inverted somewhere —
 * reachable by everyone.
 */
export function assertKnownPermission(code) {
  if (!codeSet.has(code)) {
    throw new Error(
      `Unknown permission "${code}". Declare it in src/constants/permissions.js before using it.`,
    );
  }
  return code;
}

export function unknownPermissions(codes = []) {
  return codes.filter((c) => !codeSet.has(c));
}

/**
 * Default role definitions, matching the approved permission matrix
 * (ARCHITECTURE.md §4).
 *
 * These are SEED DATA, not hard-coded authorization. Nothing in the codebase
 * checks "is this user an Admin" — every check is against a permission. That
 * is what lets you re-shape these roles, or add new ones, from the Roles screen
 * without a deployment.
 *
 * `rank` prevents privilege escalation: a user may not create or edit a role
 * whose rank is greater than or equal to their own, and may not grant a
 * permission they do not themselves hold.
 */
import { PERMISSIONS as P, ALL_PERMISSION_CODES } from './permissions.js';

const crud = (module) => [`VIEW_${module}`, `CREATE_${module}`, `UPDATE_${module}`, `DELETE_${module}`];
const view = (...modules) => modules.map((m) => `VIEW_${m}`);

export const SYSTEM_ROLES = {
  SUPER_ADMIN: {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    rank: 100,
    description: 'Unrestricted access, including security settings and other administrators.',
    permissions: [...ALL_PERMISSION_CODES],
  },

  ADMIN: {
    code: 'ADMIN',
    name: 'Admin',
    rank: 80,
    description: 'Full operational control. Cannot manage Super Admins or security-critical settings.',
    permissions: ALL_PERMISSION_CODES.filter((c) => c !== P.MANAGE_SUPER_ADMIN),
  },

  INVENTORY_MANAGER: {
    code: 'INVENTORY_MANAGER',
    name: 'Inventory Manager',
    rank: 60,
    description: 'Owns stock accuracy: adjustments, transfers, warehouse and product setup.',
    permissions: [
      ...crud('PRODUCT').filter((c) => !c.startsWith('DELETE')),
      ...crud('CATEGORY').filter((c) => !c.startsWith('DELETE')),
      ...crud('VENDOR').filter((c) => !c.startsWith('DELETE')),
      ...crud('WAREHOUSE').filter((c) => !c.startsWith('DELETE')),
      ...view('CUSTOMER', 'SALES_ORDER', 'DISPATCH_NOTE', 'WARRANTY', 'SERVICE_REQUEST'),
      'VIEW_PURCHASE_ORDER', 'CREATE_PURCHASE_ORDER', 'UPDATE_PURCHASE_ORDER',
      'VIEW_GRN', 'CREATE_GRN', 'UPDATE_GRN', P.POST_GRN,
      'VIEW_INVENTORY', 'UPDATE_INVENTORY', P.ADJUST_INVENTORY,
      'VIEW_TRANSFER', 'CREATE_TRANSFER', 'UPDATE_TRANSFER', P.DISPATCH_TRANSFER, P.RECEIVE_TRANSFER,
      'VIEW_SERIAL', 'CREATE_SERIAL', 'UPDATE_SERIAL', P.OVERRIDE_SERIAL_STATUS,
      'VIEW_RETURN', 'CREATE_RETURN', P.APPROVE_RETURN, P.SET_DISPOSITION,
      'VIEW_DOCUMENT', 'CREATE_DOCUMENT',
      P.VIEW_REPORTS, P.EXPORT_DATA,
    ],
  },

  WAREHOUSE_OPERATOR: {
    code: 'WAREHOUSE_OPERATOR',
    name: 'Warehouse Operator',
    rank: 40,
    description:
      'Receives material, posts GRNs, picks and packs, scans serials. Scoped to assigned warehouses. ' +
      'Deliberately cannot cancel a posted GRN — reversing stock history is not a receiving task.',
    permissions: [
      ...view('PRODUCT', 'CATEGORY', 'VENDOR', 'WAREHOUSE', 'PURCHASE_ORDER', 'SALES_ORDER', 'WARRANTY', 'SERVICE_REQUEST'),
      'VIEW_GRN', 'CREATE_GRN', 'UPDATE_GRN', P.POST_GRN,
      'VIEW_INVENTORY',
      'VIEW_TRANSFER', P.DISPATCH_TRANSFER, P.RECEIVE_TRANSFER,
      'VIEW_SERIAL',
      'VIEW_DISPATCH_NOTE', P.CREATE_DISPATCH,
      'VIEW_RETURN', 'CREATE_RETURN',
      'VIEW_DOCUMENT', 'CREATE_DOCUMENT',
      P.VIEW_REPORTS,
    ],
  },

  SALES_DISPATCH: {
    code: 'SALES_DISPATCH',
    name: 'Sales & Dispatch',
    rank: 50,
    description: 'Customer orders, dispatch, and customer-facing warranty.',
    permissions: [
      ...view('PRODUCT', 'CATEGORY', 'INVENTORY', 'SERIAL', 'WAREHOUSE', 'GRN'),
      ...crud('CUSTOMER').filter((c) => !c.startsWith('DELETE')),
      'VIEW_SALES_ORDER', 'CREATE_SALES_ORDER', 'UPDATE_SALES_ORDER', P.CONFIRM_SALES_ORDER,
      'VIEW_DISPATCH_NOTE', P.CREATE_DISPATCH, P.CANCEL_DISPATCH,
      'VIEW_WARRANTY', 'UPDATE_WARRANTY', P.VOID_WARRANTY,
      'VIEW_SERVICE_REQUEST', 'CREATE_SERVICE_REQUEST', P.ASSIGN_SERVICE_REQUEST,
      'VIEW_RETURN', 'CREATE_RETURN',
      'VIEW_DOCUMENT', 'CREATE_DOCUMENT',
      P.VIEW_CONTACT_DETAILS,
      P.VIEW_REPORTS, P.EXPORT_DATA,
    ],
  },

  SERVICE_ENGINEER: {
    code: 'SERVICE_ENGINEER',
    name: 'Service Engineer',
    rank: 50,
    description: 'Works service tickets: inspection, repair, replacement, closure.',
    permissions: [
      ...view('PRODUCT', 'CUSTOMER', 'VENDOR', 'INVENTORY', 'SERIAL', 'WARRANTY', 'WAREHOUSE'),
      'VIEW_SERVICE_REQUEST', 'CREATE_SERVICE_REQUEST', 'UPDATE_SERVICE_REQUEST', P.WORK_SERVICE_REQUEST,
      'VIEW_RETURN', 'CREATE_RETURN',
      'VIEW_DOCUMENT', 'CREATE_DOCUMENT',
      P.VIEW_CONTACT_DETAILS,
      P.VIEW_REPORTS,
    ],
  },

  VIEWER: {
    code: 'VIEWER',
    name: 'Viewer',
    rank: 10,
    description: 'Read-only. No exports — a read-only user who can bulk-export is not read-only.',
    permissions: [
      ...view(
        'PRODUCT', 'CATEGORY', 'VENDOR', 'CUSTOMER', 'PURCHASE_ORDER', 'GRN',
        'INVENTORY', 'WAREHOUSE', 'TRANSFER', 'SERIAL', 'SALES_ORDER',
        'DISPATCH_NOTE', 'WARRANTY', 'SERVICE_REQUEST', 'RETURN', 'DOCUMENT',
      ),
      P.VIEW_REPORTS,
    ],
  },
};

export const SYSTEM_ROLE_LIST = Object.values(SYSTEM_ROLES);
export default SYSTEM_ROLES;

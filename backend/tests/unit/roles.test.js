import { SYSTEM_ROLES, SYSTEM_ROLE_LIST } from '../../src/constants/roles.js';
import { unknownPermissions, ALL_PERMISSION_CODES } from '../../src/constants/permissions.js';

/**
 * These assert the properties of the seeded role set that would be dangerous
 * to break silently. A permission accidentally added to VIEWER, or a role
 * ranked above Admin, would not fail any other test.
 */
describe('system roles', () => {
  it('reference only permissions that exist in the catalogue', () => {
    for (const role of SYSTEM_ROLE_LIST) {
      expect({ role: role.code, unknown: unknownPermissions(role.permissions) })
        .toEqual({ role: role.code, unknown: [] });
    }
  });

  it('gives Super Admin every permission', () => {
    expect(SYSTEM_ROLES.SUPER_ADMIN.permissions.sort()).toEqual([...ALL_PERMISSION_CODES].sort());
  });

  it('withholds MANAGE_SUPER_ADMIN from every role except Super Admin', () => {
    const holders = SYSTEM_ROLE_LIST
      .filter((r) => r.permissions.includes('MANAGE_SUPER_ADMIN'))
      .map((r) => r.code);
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('keeps Viewer read-only, including exports', () => {
    const viewer = SYSTEM_ROLES.VIEWER.permissions;
    const writes = viewer.filter((p) => /^(CREATE|UPDATE|DELETE)_/.test(p));
    expect(writes).toEqual([]);
    // A read-only user who can bulk-export is not read-only.
    expect(viewer).not.toContain('EXPORT_DATA');
  });

  it('lets Warehouse Operator post a GRN but never cancel one', () => {
    const wh = SYSTEM_ROLES.WAREHOUSE_OPERATOR.permissions;
    expect(wh).toContain('POST_GRN');
    expect(wh).not.toContain('CANCEL_GRN');
  });

  it('withholds unlimited stock adjustment from everyone below Admin', () => {
    const holders = SYSTEM_ROLE_LIST
      .filter((r) => r.permissions.includes('ADJUST_INVENTORY_UNLIMITED'))
      .map((r) => r.code)
      .sort();
    expect(holders).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('withholds contact details from roles with no reason to see them', () => {
    const holders = SYSTEM_ROLE_LIST
      .filter((r) => r.permissions.includes('VIEW_CONTACT_DETAILS'))
      .map((r) => r.code)
      .sort();
    expect(holders).toEqual(['ADMIN', 'SALES_DISPATCH', 'SERVICE_ENGINEER', 'SUPER_ADMIN']);
  });

  it('ranks roles strictly below Super Admin, with unique codes', () => {
    const codes = SYSTEM_ROLE_LIST.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);

    for (const role of SYSTEM_ROLE_LIST) {
      if (role.code === 'SUPER_ADMIN') continue;
      expect(role.rank).toBeLessThan(SYSTEM_ROLES.SUPER_ADMIN.rank);
    }
  });
});

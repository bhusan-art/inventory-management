import { resolveEffectivePermissions, buildActor } from '../../src/services/shared/permissionResolver.js';

describe('resolveEffectivePermissions', () => {
  it('starts from the role permissions', () => {
    const result = resolveEffectivePermissions({ rolePermissions: ['VIEW_PRODUCT', 'CREATE_PRODUCT'] });
    expect([...result].sort()).toEqual(['CREATE_PRODUCT', 'VIEW_PRODUCT']);
  });

  it('adds per-user grants on top of the role', () => {
    const result = resolveEffectivePermissions({
      rolePermissions: ['VIEW_PRODUCT'],
      grants: ['EXPORT_DATA'],
    });
    expect(result.has('EXPORT_DATA')).toBe(true);
  });

  it('lets denies override the role', () => {
    const result = resolveEffectivePermissions({
      rolePermissions: ['VIEW_PRODUCT', 'EXPORT_DATA'],
      denies: ['EXPORT_DATA'],
    });
    expect(result.has('EXPORT_DATA')).toBe(false);
    expect(result.has('VIEW_PRODUCT')).toBe(true);
  });

  it('lets denies override grants — an ambiguous config fails closed', () => {
    const result = resolveEffectivePermissions({
      rolePermissions: [],
      grants: ['EXPORT_DATA'],
      denies: ['EXPORT_DATA'],
    });
    expect(result.has('EXPORT_DATA')).toBe(false);
  });

  it('silently drops permission codes that are not in the catalogue', () => {
    // Stale data from an older version must never become an unchecked capability.
    const result = resolveEffectivePermissions({
      rolePermissions: ['VIEW_PRODUCT', 'VIEW_PRICING', 'TOTALLY_MADE_UP'],
    });
    expect(result.has('VIEW_PRICING')).toBe(false);
    expect(result.has('TOTALLY_MADE_UP')).toBe(false);
    expect(result.has('VIEW_PRODUCT')).toBe(true);
  });
});

describe('buildActor', () => {
  const user = {
    _id: 'u1',
    tenantId: 't1',
    fullName: 'Test User',
    email: 'test@example.com',
    permissionGrants: ['EXPORT_DATA'],
    permissionDenies: ['DELETE_PRODUCT'],
    scope: { warehouseIds: [] },
  };
  const role = { _id: 'r1', code: 'TESTER', name: 'Tester', rank: 30, permissions: ['VIEW_PRODUCT', 'DELETE_PRODUCT'] };

  it('exposes convenience predicates over the resolved set', () => {
    const actor = buildActor(user, role);
    expect(actor.can('VIEW_PRODUCT')).toBe(true);
    expect(actor.can('DELETE_PRODUCT')).toBe(false);
    expect(actor.canAll('VIEW_PRODUCT', 'EXPORT_DATA')).toBe(true);
    expect(actor.canAny('DELETE_PRODUCT', 'EXPORT_DATA')).toBe(true);
  });

  it('treats an empty warehouse list as global scope', () => {
    const actor = buildActor(user, role);
    expect(actor.hasGlobalWarehouseScope).toBe(true);
    expect(actor.warehouseIds).toEqual([]);
  });

  it('treats a populated warehouse list as restricted scope', () => {
    const actor = buildActor({ ...user, scope: { warehouseIds: ['w1', 'w2'] } }, role);
    expect(actor.hasGlobalWarehouseScope).toBe(false);
    expect(actor.warehouseIds).toEqual(['w1', 'w2']);
  });
});

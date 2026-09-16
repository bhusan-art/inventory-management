import { stripRestricted } from '../../src/serializers/serialize.js';
import { serializeUser } from '../../src/serializers/user.serializer.js';

describe('stripRestricted', () => {
  it('omits denied fields entirely rather than nulling them', () => {
    // Omission matters. `phone: null` across a list still reveals which
    // records have a phone number, and `phone: "***"` additionally announces
    // that filtering is happening.
    const result = stripRestricted({ fullName: 'A', phone: '+91999' }, 'User', new Set());
    expect('phone' in result).toBe(false);
    expect(result.fullName).toBe('A');
  });

  it('keeps fields the actor is entitled to', () => {
    const result = stripRestricted({ phone: '+91999' }, 'User', new Set(['VIEW_CONTACT_DETAILS']));
    expect(result.phone).toBe('+91999');
  });

  it('removes the whole subtree when a nested field is restricted', () => {
    const result = stripRestricted(
      { name: 'V', bankDetails: { accountNumber: '123', ifsc: 'X' } },
      'Vendor',
      new Set(),
    );
    expect('bankDetails' in result).toBe(false);
  });

  it('leaves models with no registry entry untouched', () => {
    const input = { sku: 'A-1', quantity: 5 };
    expect(stripRestricted(input, 'Product', new Set())).toEqual(input);
  });
});

describe('serializeUser', () => {
  const doc = {
    _id: 'u1',
    fullName: 'Test User',
    email: 'test@example.com',
    phone: '+919999999999',
    passwordHash: '$2a$12$notarealhash',
    tokenVersion: 7,
    failedLoginAttempts: 3,
    passwordResetTokenHash: 'deadbeef',
    status: 'ACTIVE',
    sessionProfile: 'STANDARD',
    role: { _id: 'r1', code: 'VIEWER', name: 'Viewer', rank: 10 },
    permissionGrants: [],
    permissionDenies: [],
    scope: { warehouseIds: [] },
  };

  it('never emits credential or internal fields, even when present on the document', () => {
    const dto = serializeUser(doc, new Set(['VIEW_CONTACT_DETAILS']));
    expect(dto.passwordHash).toBeUndefined();
    expect(dto.tokenVersion).toBeUndefined();
    expect(dto.failedLoginAttempts).toBeUndefined();
    expect(dto.passwordResetTokenHash).toBeUndefined();
  });

  it('includes the phone only for actors holding VIEW_CONTACT_DETAILS', () => {
    expect(serializeUser(doc, new Set(['VIEW_CONTACT_DETAILS'])).phone).toBe('+919999999999');
    expect('phone' in serializeUser(doc, new Set())).toBe(false);
  });

  it('flattens the populated role', () => {
    const dto = serializeUser(doc, new Set());
    expect(dto.role).toEqual({ id: 'r1', code: 'VIEWER', name: 'Viewer', rank: 10 });
  });
});

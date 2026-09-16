import mongoose from 'mongoose';
import { RESTRICTED_FIELDS, permissionForQueryKey, deniedRestrictedFields, permittedRestrictedFields } from '../../src/constants/restrictedFields.js';
import { isKnownPermission } from '../../src/constants/permissions.js';
import '../../src/models/User.js';

/** Models named in the registry that Phase 2 will introduce. */
const PENDING_MODELS = ['Vendor', 'Customer'];

/**
 * Registry ↔ schema consistency.
 *
 * The whole access-control design assumes restricted fields are `select: false`
 * on their schema. If someone adds a registry entry for a field that is
 * selected by default, the serializer would strip it from the DTO while the
 * repository happily loaded it — and it would leak through any code path that
 * returns a raw document. This test is what stops the two drifting apart.
 */
describe('restricted-field registry', () => {
  it('names only permissions that exist', () => {
    for (const [model, fields] of Object.entries(RESTRICTED_FIELDS)) {
      for (const [field, permission] of Object.entries(fields)) {
        expect({ model, field, known: isKnownPermission(permission) })
          .toEqual({ model, field, known: true });
      }
    }
  });

  it('marks every registered restricted path as select:false on its schema', () => {
    for (const [modelName, fields] of Object.entries(RESTRICTED_FIELDS)) {
      if (PENDING_MODELS.includes(modelName)) continue;

      const model = mongoose.models[modelName];
      expect(model).toBeDefined();

      for (const field of Object.keys(fields)) {
        const path = model.schema.path(field) ?? model.schema.path(field.split('.')[0]);
        expect({ modelName, field, exists: Boolean(path) }).toEqual({ modelName, field, exists: true });
        expect({ modelName, field, hidden: path.options?.select === false })
          .toEqual({ modelName, field, hidden: true });
      }
    }
  });

  it('only lists pending models that really are unbuilt', () => {
    // Prevents the escape hatch above outliving its purpose: once Phase 2 adds
    // Vendor, this test fails until PENDING_MODELS is trimmed.
    for (const name of PENDING_MODELS) {
      expect({ name, registered: Boolean(mongoose.models[name]) })
        .toEqual({ name, registered: false });
    }
  });
});

describe('query key resolution', () => {
  const none = new Set();
  const withContacts = new Set(['VIEW_CONTACT_DETAILS']);

  it('resolves a plain restricted field', () => {
    expect(permissionForQueryKey('User', 'phone')).toBe('VIEW_CONTACT_DETAILS');
  });

  it('ignores sort direction prefixes', () => {
    expect(permissionForQueryKey('User', '-phone')).toBe('VIEW_CONTACT_DETAILS');
    expect(permissionForQueryKey('User', '+phone')).toBe('VIEW_CONTACT_DETAILS');
  });

  it('resolves a dotted path against its root', () => {
    // bankDetails.ifsc must be covered by the rule on bankDetails, otherwise
    // the guard is trivially bypassed by querying one level deeper.
    expect(permissionForQueryKey('Vendor', 'bankDetails.ifsc')).toBe('VIEW_VENDOR_BANK_DETAILS');
  });

  it('returns null for unrestricted fields', () => {
    expect(permissionForQueryKey('User', 'fullName')).toBeNull();
    expect(permissionForQueryKey('Product', 'sku')).toBeNull();
  });

  it('splits fields by what the actor may read', () => {
    expect(permittedRestrictedFields('User', none)).toEqual([]);
    expect(deniedRestrictedFields('User', none)).toEqual(['phone']);
    expect(permittedRestrictedFields('User', withContacts)).toEqual(['phone']);
    expect(deniedRestrictedFields('User', withContacts)).toEqual([]);
  });
});

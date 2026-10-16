import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { collectRoutes } from '../../src/services/docs/openApiService.js';
import { ALL_PERMISSION_CODES } from '../../src/constants/permissions.js';
import { SYSTEM_ROLES } from '../../src/constants/roles.js';

/**
 * Every declared permission should mean something.
 *
 * The registry generates VIEW/CREATE/UPDATE/DELETE for each module, so codes
 * exist for operations the API never implemented — `UPDATE_INVENTORY`,
 * `CREATE_DISPATCH_NOTE`, `DELETE_WARRANTY`. They are granted to roles and
 * enforced by nothing.
 *
 * That is not a security hole; it is a trap for whoever configures a custom
 * role next. Granting `CREATE_DISPATCH_NOTE` to a user looks exactly like
 * granting the ability to create dispatch notes, and the real gate is
 * `CREATE_DISPATCH`. The person tests it, it fails, and they go looking for a
 * bug in the dispatch screen.
 *
 * This test does not demand they be removed — deleting a granted permission
 * changes every seeded role, which is a migration. It pins the list instead:
 * the set is a known quantity, and it cannot grow without somebody saying so.
 */

/** A permission can be enforced by a route gate, a service, or the restricted-field registry. */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    // `constants/permissions.js` and `constants/roles.js` DECLARE every code,
    // so including them would make everything look used. `restrictedFields.js`
    // is the exception: it is where field-level permissions are enforced.
    else if (entry.endsWith('.js')
      && (!full.includes('constants') || entry === 'restrictedFields.js')) found.push(full);
  }
  return found;
}

/**
 * Comments are stripped before searching.
 *
 * The first version matched this file's own prose: a doc comment here naming
 * `CREATE_DISPATCH_NOTE` as an example of a dead permission was enough to make
 * the check report it as enforced. The same mistake as the Phase 3 guard whose
 * comment contained the literal string it was searching for — a check that
 * reads explanations as evidence will always agree with itself.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const app = createApp();

const onRoutes = new Set(
  collectRoutes(app).flatMap((r) => r.requires ?? []),
);

const SRC = new URL('../../src', import.meta.url).pathname;
const code = sourceFiles(SRC).map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

const enforced = (permission) => onRoutes.has(permission)
  // A word-boundary match, not a quoted one: the restricted-field registry
  // writes `P.VIEW_CONTACT_DETAILS`, a property reference with no quotes
  // anywhere. Requiring quotes reported a permission enforced on every vendor
  // and customer record as dead. Safe to widen, because the two files that
  // merely DECLARE every code are excluded above.
  || new RegExp(`\\b${permission}\\b`).test(code);

/**
 * Checked by nothing, as of Phase 15. Shrinking this list is good; growing it
 * means a permission was added and never wired up.
 */
const KNOWN_UNENFORCED = [
  'CREATE_DISPATCH_NOTE', 'UPDATE_DISPATCH_NOTE', 'DELETE_DISPATCH_NOTE',
  'CREATE_INVENTORY', 'UPDATE_INVENTORY', 'DELETE_INVENTORY',
  'CREATE_WARRANTY', 'UPDATE_WARRANTY', 'DELETE_WARRANTY',
  'UPDATE_GRN', 'DELETE_GRN', 'DELETE_PURCHASE_ORDER',
  'DELETE_TRANSFER', 'DELETE_SERIAL', 'DELETE_SALES_ORDER',
  'UPDATE_SERVICE_REQUEST', 'DELETE_SERVICE_REQUEST',
  'UPDATE_RETURN', 'DELETE_RETURN', 'UPDATE_DOCUMENT',
  'VIEW_SETTING', 'CREATE_SETTING', 'UPDATE_SETTING', 'DELETE_SETTING',
];

describe('declared permissions are wired to something', () => {
  it('finds the route table', () => {
    expect(onRoutes.size).toBeGreaterThan(50);
  });

  it('has no unenforced permission outside the known list', () => {
    const unenforced = ALL_PERMISSION_CODES.filter((c) => !enforced(c));
    const unexpected = unenforced.filter((c) => !KNOWN_UNENFORCED.includes(c));

    expect(unexpected).toEqual([]);
  });

  it('does not keep entries that have since been wired up', () => {
    // Otherwise the list rots into a lie in the opposite direction.
    const nowEnforced = KNOWN_UNENFORCED.filter((c) => enforced(c));
    expect(nowEnforced).toEqual([]);
  });

  it('only names permissions that actually exist', () => {
    const bogus = KNOWN_UNENFORCED.filter((c) => !ALL_PERMISSION_CODES.includes(c));
    expect(bogus).toEqual([]);
  });

  it('warns that unenforced permissions are still granted to roles', () => {
    // The trap, stated as a fact: these are handed out and do nothing.
    const granted = KNOWN_UNENFORCED.filter((c) => Object.values(SYSTEM_ROLES)
      .some((r) => r.permissions.includes(c)));

    // Not an assertion that it is wrong — an assertion that we know.
    expect(granted.length).toBeGreaterThan(0);
  });
});

describe('notifications reach a real audience', () => {
  /**
   * `recipientPermission` is a free string on the model. Addressed to a
   * permission that does not exist, a notification is written, counted, and
   * delivered to nobody — with no error anywhere. `notify()` now asserts the
   * code; this checks every call site passes one that exists.
   */
  it('every recipientPermission in the codebase is a real permission', () => {
    const used = [...code.matchAll(/recipientPermission:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(3);

    for (const permission of used) {
      expect([permission, ALL_PERMISSION_CODES.includes(permission)]).toEqual([permission, true]);
    }
  });

  it('every recipientPermission is held by at least one role', () => {
    // A valid code nobody holds is the same silent failure wearing a disguise.
    const used = [...new Set([...code.matchAll(/recipientPermission:\s*'([A-Z_]+)'/g)].map((m) => m[1]))];

    for (const permission of used) {
      const holders = Object.values(SYSTEM_ROLES)
        .filter((r) => r.permissions.includes(permission) || r.permissions.includes('*'));
      expect([permission, holders.length > 0]).toEqual([permission, true]);
    }
  });
});

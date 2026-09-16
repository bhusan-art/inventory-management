# Phase 1 — Authentication and Access Control

## Exit criteria

> Permission matrix suite green for all seven roles; token rotation and reuse
> detection proven.

## What was delivered

**Tenancy hook** — `Company` model plus a `tenantId` on every tenant-scoped
collection, injected automatically by `BaseRepository`. One company is seeded
and there is no multi-company UI, but the enforcement path is live and tested
(`permissions.matrix.test.js` → "tenant isolation").

**Authentication**
- Login, logout, logout-all, refresh, change password, forgot/reset password.
- Access token: 15-minute JWT carrying a permission snapshot plus `tokenVersion`.
- Refresh token: opaque, HttpOnly, `SameSite=Strict`, path-scoped, stored as a
  SHA-256 hash with a TTL index.
- Rotation with reuse detection: replaying a spent token revokes the whole
  token family, bumps `tokenVersion`, writes a `CRITICAL` audit entry.
- Account lockout after five failed attempts.
- `KIOSK` session profile with a 30-day refresh window for warehouse devices.

**Authorization**
- 100+ permission catalogue, seven system roles, `rank`-based privilege ceiling.
- Effective permissions = role ∪ grants − denies.
- Route guards (`requirePermission`), field guards (registry + serializer),
  query guards (sort/filter/search), warehouse scope on the user record.
- Privilege escalation blocked in both directions: you cannot assign a role at
  or above your own rank, and you cannot grant a permission you do not hold.

**Infrastructure**
- Append-only `AuditLog` with ODM-level update/delete hooks, restricted values
  redacted in change diffs.
- Idempotent seed script generating unique passwords per run, printed once.

**Frontend**
- Access token in memory only; session restored from the refresh cookie at boot.
- Single-flight refresh queue, login, forced password change, permission hooks,
  `PermissionGuard`, route protection.

## Verification

| | |
|---|---|
| Unit tests | 37 passing (permission resolution, role definitions, registry↔schema consistency, serializers, errors) |
| Backend lint | clean, including the architectural guardrails |
| Frontend lint + build | clean, 253 kB bundle |
| Integration suites | written; run in CI against a real replica set |

The permission matrix suite derives expected access from the role definitions
rather than a hand-written table, so changing a role's permissions changes the
test's expectations automatically and the two cannot drift apart.

## Three things worth knowing

**The ESLint guardrail caught a real bypass during this phase.** `authService`
was selecting `+passwordHash` directly. Credential reads now live in
`user.repository.js` as three named methods, so every place the application can
read a credential is visible in one file.

**The client's refresh queue is a security control, not an optimization.**
Without it, several components hitting a 401 at once each fire a refresh; all
but the first replay an already-rotated token, the backend correctly reads that
as theft, and the user is signed out. The single-flight promise stops the client
tripping the server's reuse detection.

**Frontend guards are labelled as presentation, in their own source.** Anyone
editing `usePermission.js` or `PermissionGuard.jsx` is told there that the
server has already decided.

## A registry test that expires on purpose

`restrictedFields.test.js` lists `Vendor` and `Customer` as pending models.
A third assertion fails once either is registered, so Phase 2 cannot introduce
those models without trimming the exemption and bringing them under the
registry↔schema check.

## Not in this phase

No master data, no stock, no business logic. Phase 2 adds products, categories,
brands, manufacturers, vendors, customers and warehouses — with the restricted
fields on vendor and customer records being the first real exercise of the
field-level controls built here.

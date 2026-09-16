# Phase 2 — file manifest

Everything that differs from the Phase 1 zip. Nothing else was touched.

## Modified (7 files)

* `backend/src/constants/restrictedFields.js`
* `backend/src/db/seed.js`
* `backend/src/routes/v1/index.js`
* `backend/tests/integration/permissions.matrix.test.js`
* `backend/tests/unit/restrictedFields.test.js`
* `frontend/src/app/routes.jsx`
* `frontend/src/features/dashboard/DashboardPage.jsx`

## New (25 files)

* `backend/src/controllers/master.controller.js`
* `backend/src/controllers/vendor.controller.js`
* `backend/src/models/Customer.js`
* `backend/src/models/Product.js`
* `backend/src/models/Vendor.js`
* `backend/src/models/Warehouse.js`
* `backend/src/models/classification.js`
* `backend/src/repositories/vendor.repository.js`
* `backend/src/routes/v1/master.routes.js`
* `backend/src/routes/v1/masterData.js`
* `backend/src/serializers/master.serializer.js`
* `backend/src/services/master/index.js`
* `backend/src/services/master/productImport.js`
* `backend/src/services/shared/crudFactory.js`
* `backend/src/services/shared/referenceGuard.js`
* `backend/src/validators/master.schema.js`
* `backend/tests/integration/masterData.test.js`
* `backend/tests/unit/csvImport.test.js`
* `backend/tests/unit/masterValidation.test.js`
* `docs/PHASE-2.md`
* `frontend/src/components/table/DataTable.jsx`
* `frontend/src/constants/navigation.js`
* `frontend/src/features/master/MasterListPage.jsx`
* `frontend/src/features/master/masterConfig.js`
* `frontend/src/layouts/AppLayout.jsx`

## Deleted

None.

\# Phase 1 — Authentication and Access Control



\## Exit criteria



> Permission matrix suite green for all seven roles; token rotation and reuse

> detection proven.



\## What was delivered



\*\*Tenancy hook\*\* — `Company` model plus a `tenantId` on every tenant-scoped

collection, injected automatically by `BaseRepository`. One company is seeded

and there is no multi-company UI, but the enforcement path is live and tested

(`permissions.matrix.test.js` → "tenant isolation").



\*\*Authentication\*\*

\- Login, logout, logout-all, refresh, change password, forgot/reset password.

\- Access token: 15-minute JWT carrying a permission snapshot plus `tokenVersion`.

\- Refresh token: opaque, HttpOnly, `SameSite=Strict`, path-scoped, stored as a

&#x20; SHA-256 hash with a TTL index.

\- Rotation with reuse detection: replaying a spent token revokes the whole

&#x20; token family, bumps `tokenVersion`, writes a `CRITICAL` audit entry.

\- Account lockout after five failed attempts.

\- `KIOSK` session profile with a 30-day refresh window for warehouse devices.



\*\*Authorization\*\*

\- 100+ permission catalogue, seven system roles, `rank`-based privilege ceiling.

\- Effective permissions = role ∪ grants − denies.

\- Route guards (`requirePermission`), field guards (registry + serializer),

&#x20; query guards (sort/filter/search), warehouse scope on the user record.

\- Privilege escalation blocked in both directions: you cannot assign a role at

&#x20; or above your own rank, and you cannot grant a permission you do not hold.



\*\*Infrastructure\*\*

\- Append-only `AuditLog` with ODM-level update/delete hooks, restricted values

&#x20; redacted in change diffs.

\- Idempotent seed script generating unique passwords per run, printed once.



\*\*Frontend\*\*

\- Access token in memory only; session restored from the refresh cookie at boot.

\- Single-flight refresh queue, login, forced password change, permission hooks,

&#x20; `PermissionGuard`, route protection.



\## Verification



| | |

|---|---|

| Unit tests | 42 passing (permission resolution, role definitions, registry↔schema consistency, serializers, filter sanitization, errors) |

| Backend lint | clean, including the architectural guardrails |

| Frontend lint + build | clean, 253 kB bundle |

| Integration suites | written; run in CI against a real replica set |



The permission matrix suite derives expected access from the role definitions

rather than a hand-written table, so changing a role's permissions changes the

test's expectations automatically and the two cannot drift apart.



\## Fixed during this phase: a global setting that would have broken Phase 4



Phase 0 shipped with `mongoose.set('sanitizeFilter', true)` in `config/db.js`.

It neutralises operator injection from user input, but it cannot tell user

input from a query a developer wrote, so it wrapped every legitimate operator

in `$eq`:



```

{ \_id: { $nin: \[...] } }              → { \_id: { $eq: { $nin: \[...] } } }

{ availableQuantity: { $gte: qty } }  → { availableQuantity: { $eq: { $gte: qty } } }

```



The first line made the seed script fail with a `CastError`, which is how this

was found. The second line is the guarded atomic update that prevents negative

stock (ARCHITECTURE.md §0.8). It would not have thrown — it would simply have

stopped matching, and every inventory decrement in Phase 4 onward would have

failed as "insufficient stock" against a warehouse holding hundreds of units.



Mongoose's intended remedy is `mongoose.trusted()` at every call site, which

trades a loud failure for a silent one: forget it once and the query quietly

returns nothing.



\*\*Resolution.\*\* The global setting is removed and documented as deliberately

off. Injection is blocked at the boundary where untrusted input actually

becomes a filter — `sanitizeUserFilter` in `validators/common.schema.js`,

applied by the list-query schema, which strips `$` keys and operator objects

from anything arriving over HTTP. Filters written in service code keep their

operators, because code is not untrusted input.



Two regression tests guard this: one asserts the global setting is off, the

other demonstrates exactly what it would do to the stock guard if re-enabled.



The lesson worth carrying forward: a security control that cannot distinguish

trusted from untrusted callers is not a control, it is a trap. The audit before

Phase 0 shipped did not catch it because no code at that point used a query

operator in a filter — the seed script was the first that did.



\## Three things worth knowing



\*\*The ESLint guardrail caught a real bypass during this phase.\*\* `authService`

was selecting `+passwordHash` directly. Credential reads now live in

`user.repository.js` as three named methods, so every place the application can

read a credential is visible in one file.



\*\*The client's refresh queue is a security control, not an optimization.\*\*

Without it, several components hitting a 401 at once each fire a refresh; all

but the first replay an already-rotated token, the backend correctly reads that

as theft, and the user is signed out. The single-flight promise stops the client

tripping the server's reuse detection.



\*\*Frontend guards are labelled as presentation, in their own source.\*\* Anyone

editing `usePermission.js` or `PermissionGuard.jsx` is told there that the

server has already decided.



\## A registry test that expires on purpose



`restrictedFields.test.js` lists `Vendor` and `Customer` as pending models.

A third assertion fails once either is registered, so Phase 2 cannot introduce

those models without trimming the exemption and bringing them under the

registry↔schema check.



\## Not in this phase



No master data, no stock, no business logic. Phase 2 adds products, categories,

brands, manufacturers, vendors, customers and warehouses — with the restricted

fields on vendor and customer records being the first real exercise of the

field-level controls built here.


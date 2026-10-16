# 

Phase 12 — change manifest



Replace the files below in C:\\Users\\sonub\\Downloads\\Inventory project\\inventory-management.



Unzip the snapshot over the project, or apply these by hand. Nothing in this phase requires a migration, but one file changes behaviour at boot — see After unzipping at the end.



New files

Backend

Path	What it is

backend/src/middleware/rateLimit.js	One factory for every rate limiter. Routes 429s through the error handler.

backend/src/services/docs/openApiService.js	Generates the OpenAPI document by walking the live router.

backend/src/routes/v1/docs.routes.js	Serves /api/v1/docs and /api/v1/docs/openapi.json.

backend/src/services/audit/auditQueryService.js	Reads the audit trail. Read-only — the model refuses writes at the ODM level.

backend/src/controllers/audit.controller.js	Serializes audit entries; nulls payloads on redacted ones.

backend/src/routes/v1/audit.routes.js	Four GET routes behind one router.use(requirePermission('VIEW\_AUDIT\_LOGS')).

backend/scripts/load-test.mjs	Concurrency measurement against a running server.

backend/.env.production.example	Production environment, annotated with what each boot guard checks.

backend/tests/unit/openApi.test.js	17 tests.

backend/tests/unit/requestLimits.test.js	10 tests.

backend/tests/unit/productionConfig.test.js	12 tests.

backend/tests/unit/auditVocabulary.test.js	4 tests. Reads the frontend page and fails on severity drift.

backend/tests/integration/security.test.js	39 tests. Needs the Docker stack.

Frontend

Path	What it is

frontend/src/features/audit/AuditLogPage.jsx	The audit trail screen.

Root

Path	What it is

scripts/backup.sh	Database and documents, together.

scripts/restore.sh	Restores both, with a typed confirmation and a verification pass.

docker/certs/README.md	What nginx expects, and that it exits without it.

docs/DEPLOYMENT.md	First-run procedure, boot-refusal table, backup/restore, operating notes.

docs/PHASE-12.md	This phase in full.

Modified files

Backend

Path	Change

src/app.js	Global limiter moved to the factory; express-rate-limit import dropped.

src/middleware/errorHandler.js	body-parser failures mapped: 413 PAYLOAD\_TOO\_LARGE, 400 MALFORMED\_BODY, 415 UNSUPPORTED\_ENCODING. Were all 500 INTERNAL\_ERROR.

src/utils/errors.js	Adds RateLimitedError.

src/middleware/authorize.js	The gate now carries requiredPermissions (frozen) so the generator can read it.

src/config/env.js	Adds DOCUMENT\_STORAGE\_PATH and DOCS\_ENABLED to the schema; adds productionConfigProblems(), exported and tested.

src/routes/v1/auth.routes.js	Uses the limiter factory.

src/routes/v1/index.js	Mounts the docs and audit routers.

src/services/documents/storage.js	Reads DOCUMENT\_STORAGE\_PATH from validated env, not process.env.

src/services/audit/auditQueryService.js	Vocabulary now publishes severities from the schema enum.

tests/helpers/fixtures.js	seedTenant({ name, code }), so a second tenant can exist.

tests/integration/permissions.matrix.test.js	+4 audit endpoints → 108 total.

Frontend

Path	Change

src/app/routes.jsx	Adds the /audit-logs route.

src/constants/navigation.js	Adds the Audit Trail link under Administration.

scripts/check-navigation.mjs	Parses routes.jsx instead of keeping its own list of standalone routes.

Root

Path	Change

.gitignore	Now covers .env.production, \*.pem, the mongo keyfile and backups/. It did not.

docker-compose.prod.yml	Authenticated healthcheck that also initiates the set; no source mounts; no published DB port; resource limits; storage volume on the worker; certs mount.

docker/nginx.conf	TLS termination, http→https redirect leaving ACME alone, no duplicate security headers on /api/, proxy\_buffering off for streamed exports, immutable asset caching.

After unzipping

1\. Reinstall nothing



No new dependencies. If you rebuild anyway, use:



powershell

docker compose up -d --build --renew-anon-volumes



(The anonymous volume shadowing node\_modules is what hid the missing multer in Phase 10.)



2\. Add two settings to backend/.env



Both have working defaults, so the app starts without them — but they are now validated, and an invalid value is refused where it used to be ignored:



env

DOCUMENT\_STORAGE\_PATH=./storage/documents

DOCS\_ENABLED=true



DOCS\_ENABLED only matters in production; in development the docs page is always served.



3\. Run the suites

powershell

docker compose exec backend npm test -- tests/unit

docker compose exec backend npm test -- tests/integration/security.test.js

docker compose exec backend npm test -- tests/integration/permissions.matrix.test.js

docker compose exec backend npm run lint



Expect 258 unit tests and 39 security tests.



4\. Look at the new screens

http://localhost:5173/audit-logs — sign in as ADMIN or SUPER\_ADMIN. Only those two hold VIEW\_AUDIT\_LOGS; the link is hidden for everyone else.

http://localhost:5000/api/v1/docs — the generated API reference.

5\. Optional: measure the Phase 8 conflict

powershell

docker compose exec backend node scripts/load-test.mjs `

&#x20; --url http://localhost:5000 --email <your-admin> --password '<password>' `

&#x20; --scenario read --concurrency 20 --requests 400



read is safe. The dispatch and adjust scenarios write and refuse to run without --i-know-this-writes.



What did not change



No schema changes, no migrations, no new dependencies, no changes to any existing endpoint's behaviour — except that three previously-500 responses are now 413/400/415, and a 429 now carries a top-level code. Both are the documented contract being honoured rather than a contract change.

# Phase 12 — Audit Trail, API Documentation, Security Pass, Deployment

## Exit criterion

> The audit log can be read; the documentation cannot describe an endpoint that
> does not exist; a misconfigured production deployment refuses to start.

All three met. The security pass found three defects in shipped code and one in
code written this phase.

## What was delivered

**Audit trail, readable.** The `AuditLog` model has been collecting since Phase
1 with no way to query it. Four endpoints behind `VIEW\_AUDIT\_LOGS`, and a screen
with filters, a field-level diff and a seven-day summary.

**OpenAPI, generated.** 133 paths, 174 operations, 155 with a declared
permission — read out of the live Express router.

**Security pass.** A consolidated suite of 39 tests for the failures that
belong to no single module.

**Deployment.** A production stack that is actually runnable, boot-time
configuration guards, and backup/restore.

\---

## The documentation reads the router

A hand-written spec is a second source of truth about the same API, and the two
diverge the first week nobody updates it. Worse, they diverge *silently*:
documentation that is merely out of date looks exactly like documentation that
is correct.

So the spec walks Express's own route table. If a route exists it is in the
spec; if it was deleted it vanishes. **The spec cannot describe an endpoint that
does not exist** — the one guarantee a hand-written file can never make.

What it cannot derive is body shapes: those live in Zod schemas that would need
a converter. Rather than half-describe them and imply more precision than
exists, the spec documents paths, methods, parameters, auth and the required
permission, and says plainly that bodies are validated server-side. An honest
partial spec beats a complete-looking one that lies.

### Three bugs in the generator, all mine

**Reading a closure's source.** The first version scraped
`requirePermission('X')` out of the middleware function's text. That cannot
work: a closure's captured values are not recoverable from its source. The gate
now volunteers its own answer —

```js
permissionGate.requiredPermissions = Object.freeze(\[...codes]);
```

— which is also the only version that stays correct when a permission is passed
in a variable.

**Building the app per request.** The handler called `createApp()` on every
request: a fresh rate limiter each time (express-rate-limit says so loudly) and
a circular import besides — app → routes → docs → app. It now takes `req.app`
and caches per app in a `WeakMap`. Documenting the app that is actually running
is more honest anyway.

**Ignoring router-level gates.** A permission can sit on one route or on a whole
router:

```js
auditRouter.use(requirePermission('VIEW\_AUDIT\_LOGS'));
```

The walker only looked inside `route.stack`, so every audit endpoint was
documented as merely "authenticated". That is **under**-reporting the
requirement, which is the dangerous direction: it sends someone building a
client against an assumption the server will refuse. Permissions now accumulate
down the stack in declaration order.

The test for that last one asserts all four audit routes carry
`\['VIEW\_AUDIT\_LOGS']`, and was verified to fail when the accumulation is
removed.

\---

## The security pass

### A 429 had no `code`

`express-rate-limit`'s `message:` option makes the limiter write its own
response, which **bypasses the error handler**. So rate limiting was the one
reply in the system with no top-level `code` and no `requestId`:

```
status: 429
body: { success:false, message:"Too many attempts...", errors:\[{code:"RATE\_LIMITED"}] }
top-level code present: false
```

ARCHITECTURE.md tells clients to match on `code` and never on message text. A
client doing exactly the documented thing got `undefined` and fell through to a
generic failure. This is the same defect class Phase 8 fixed everywhere else —
in the one place Phase 8 did not look, because it is not an error path anyone
writes by hand.

The limiter now passes a `RateLimitedError` to `next`, so the 429 goes through
the same handler as everything else. There is one error shape and it cannot
drift again.

A second problem came out with it. The limits were written at each call site as:

```js
limit: env.isTest ? 100\_000 : 5
```

The production number was therefore **unreachable from a test** — the 429 path
had never once executed in the suite. One factory now, with a `force` flag so a
test can ask for the real limit.

### A bad request body returned 500

```
OVERSIZED       -> 500 INTERNAL\_ERROR
MALFORMED JSON  -> 500 INTERNAL\_ERROR
```

Both are the *client's* mistake reported as a server fault. That pages whoever
is on call, spends the error budget, and in production the message is replaced
with "An unexpected error occurred" — so the caller cannot distinguish a 2MB
upload from a crash.

They never reach a validator: `express.json` throws while reading the body,
before any route or schema has been chosen. Now `413 PAYLOAD\_TOO\_LARGE`,
`400 MALFORMED\_BODY` and `415 UNSUPPORTED\_ENCODING`.

### Production secrets would have been committed

`.gitignore` had `.env` and `.env.\*.local`. Gitignore patterns are literal, so
neither matches `.env.production` — the file this phase created to hold the
database password, both JWT secrets and the production hostname. Also uncovered:
`\*.pem`, the MongoDB keyfile, and `backups/`, which contains the entire database
and every uploaded document.

The rule is now "ignore every `.env` variant, then un-ignore the examples",
rather than a list of the variants someone has thought of so far. Verified by
staging a scratch repository with all the files present and confirming only the
examples are tracked.

### My own audit page mislabelled a third of the trail

The severity enum has four values. I wrote three and let `?? INFO` cover the
gap. `NOTICE` has **29 call sites** — every one of them would have rendered as
"Info", a milder claim than the record makes, and `NOTICE` was missing from the
filter entirely so they could not be found deliberately either.

Both failures are invisible. The page renders, nothing errors.

The severity list now comes from the schema through the vocabulary endpoint, so
a new severity becomes selectable without anyone touching the frontend. A test
reads the page's source and fails if the backend can write a severity the
frontend cannot name — and fails too if the `?? SEVERITY.INFO` fallback comes
back, because silently relabelling an unknown severity as the mildest one is a
claim about the record rather than an admission of ignorance.

The test reaches across the package boundary deliberately: the enum lives in the
backend, so the obligation lives there too. Adding a severity should fail in the
suite of the package that added it, not the one that forgot.

\---

## What the security suite asserts

The rule for that file is **assert the outcome, not the mechanism**. "Tenant B
cannot read tenant A's vendor" must hold whether the protection lives in a
filter, a scope check or a middleware — and must keep holding when that moves.

|||
|-|-|
|Token forgery|wrong secret, `alg:none`, wrong issuer/audience, expired, not a JWT, malformed header|
|Revocation|deactivated, soft-deleted, `tokenVersion` bumped, and a password change killing **every other session**|
|Cross-tenant|read, update, delete and list another tenant's records; a forged `tid` claim|
|Existence oracle|a real foreign id and a fake one must return the **same** status, or the API enumerates a competitor's record ids|
|Mass assignment|`tenantId` in a request body is ignored|
|Injection|`{$ne:null}` as a login, `?field\[$ne]=` bracket notation, `.\*` as a search term|
|Disclosure|no password hash, no refresh token in the body, no stack traces, identical reply for unknown email and wrong password|
|Transport|no `x-powered-by`, `nosniff`, framing, body-size limit|

Two of those deserve a note.

**404, not 403, across tenants.** A 403 on a real id and a 404 on a fake one is
an existence oracle. The test asserts the two statuses are *equal* rather than
asserting either value, because what matters is that they cannot be told apart.

**A password change must kill other sessions.** Changing a password is what
someone does when they suspect a compromise. Leaving the attacker's session
alive defeats the entire point of offering the feature.

### Cross-tenant tests need a second tenant

`seedTenant()` created one. Every `tenantId` filter in the system was therefore
untested — the suite passed identically whether the filter was there or not.
It now takes a name and code so a second tenant can exist to leak to.

\---

## Four assertion bugs caught before you ran anything

Integration tests need the Docker stack, so a wrong assertion costs a round
trip. These were all found by checking against the real code instead:

* I invented a `STORE\_KEEPER` role. The real one is `WAREHOUSE\_OPERATOR`.
* `Vendor` fields are `vendorName`/`vendorCode`, not `name`/`code`.
* `Product` requires `productCode`, `category` and `productType` — there is no
`trackingMode` or `unit`.
* Every auth-failure code was verified against the running app rather than read
off the middleware.

This is the same class of mistake as the four in Phase 11, and the same remedy:
check, do not theorise.

\---

## The navigation guard could be satisfied without fixing anything

`check-navigation.mjs` exists because Phase 4 shipped a "Stock Counts" link with
no route behind it. It kept its own hand-written list of standalone routes — so
adding the audit route and its link *correctly* still failed, and the obvious
way to make it pass is to add the path to the guard rather than to the router.

**A guard that can be satisfied without fixing the problem is worse than no
guard**, because it teaches people to edit the guard. It now parses
`routes.jsx`, and a path reaches the set only by existing in the router. It also
fails loudly if the parse matches nothing, so the check cannot quietly become a
no-op. 23 links, all routed.

\---

## Configuration refuses rather than drifts

`src/config/env.js` claimed configuration was "validated once, at boot". Two
settings were read straight off `process.env` at their call sites:
`DOCS\_ENABLED` and `DOCUMENT\_STORAGE\_PATH`. The second is the dangerous one — a
typo means every uploaded document is written somewhere nobody looks, with no
error, and the mistake surfaces only when a file is wanted back.

Both are now in the schema. And production gets guards for the
misconfigurations that *do not announce themselves*:

* a secret under 32 characters (the schema accepts 16; the token is the entire
authorization model)
* the two secrets being equal
* `CLIENT\_URL` unset or still localhost — every browser request from the real
domain is then refused by CORS, which presents as a backend outage
* a plain-http origin, which cannot carry a `Secure` refresh cookie
* a `MONGODB\_URI` with no credentials, against a mongod running `--auth`
* a `MONGODB\_URI` with no `replicaSet` — transactions are unavailable without
one and **standalone does not error**, the transactions silently do nothing
* `LOG\_LEVEL=silent`

They are collected and printed together, so a first deployment learns
everything that is wrong in one attempt instead of one restart per problem. Both
directions are tested: every problem caught, and a sound configuration passing
cleanly. A guard that blocks a *correct* deploy is worse than none, because the
instinct under pressure is to delete it.

The production stack also had three things wrong that would have stopped it
booting at all: a keyfile that does not exist until you make it, an
unauthenticated healthcheck that cannot pass under `--auth` (so `depends\_on`
never releases the backend — an outage with a tidy explanation), and nginx
terminating no TLS while the new guard demands an https origin.

\---

## Verification

|||
|-|-|
|Unit tests|**258 passing**, up from 215 — 43 new: OpenAPI generation 17, request limits 10, production config 12, severity drift 4|
|Integration|`security.test.js` — 39 tests over token forgery, revocation, cross-tenant IDOR, injection, mass assignment, disclosure, transport|
|Permission matrix|108 endpoints × 7 roles|
|Navigation check|23 links, all routed; guard now parses the router|
|Lint + guards|clean, both packages|
|`npm audit --omit=dev`|0 vulnerabilities|
|Frontend build|clean|

Every fix in this phase was verified in three states: the test passes clean,
fails with the bug reintroduced, and passes again restored. Four of my own
guards have been wrong in earlier phases, which is why that is now the routine
and not a flourish.

\---

## Still open

**The dispatch `TRANSACTION\_CONFLICT` from Phase 8 is still unexplained.** I
proposed three mechanisms and all three were wrong; mongod logs no aborted
transaction and the test passes in isolation. What I never did was measure it,
so this phase ships an instrument rather than a fourth theory:

```bash
node scripts/load-test.mjs --url http://localhost:5000 \\
  --email <admin> --password '<password>' \\
  --scenario read --concurrency 20 --requests 400
```

It reports latency distribution and the exact error codes under concurrency, and
asserts **no thresholds** — a threshold I invented would measure only whether
reality matched my guess. The `dispatch` scenario is the suspect path and
refuses to run without `--i-know-this-writes`. Compare its output against
`docker compose logs mongo` filtered on `transaction` for the same window.

**Whether completing a stock count should require `ADJUST\_INVENTORY\_UNLIMITED`.**
Flagged in Phase 4, never decided. A count completion can move stock by any
amount, which is exactly what that permission governs elsewhere — but the
person counting a shelf is not usually the person trusted with unlimited
adjustments. It needs your answer, not mine.

**No email transport.** Password reset issues a token an administrator conveys
by hand, and scheduled report delivery is unimplemented. This was deferred from
Phase 11 as a deployment decision and remains one: it needs an SMTP provider.

**No dark mode**, though the validated palette is recorded.

**The OpenAPI spec does not describe request bodies.** Deliberate, and the spec
says so, but a Zod-to-JSON-Schema converter would close it properly.


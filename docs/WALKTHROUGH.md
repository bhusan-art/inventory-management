# What We Have Built — A Walkthrough

A reference for the Inventory Management System, written to be read rather than
skimmed. It covers what the system does, why the code is shaped the way it is,
and the ideas worth carrying to your next project.

Contents:

1. What the system is for
2. The ten decisions that shape everything
3. Phase by phase — what was built and why
4. How a request moves through the code
5. Eleven concepts worth understanding properly
6. The guardrails
7. Bugs we hit, and what each one taught
8. Where everything lives
9. What is still to come
10. Glossary

---

## 1. WHAT THE SYSTEM IS FOR

The one-sentence version: **track every unit of stock from the moment a
purchase order is raised to the moment its warranty expires, and be able to
prove what happened to it.**

That last clause is the hard part. Plenty of software can tell you "we have 47
servers." Far less can tell you: *this specific server, serial SRV0042, arrived
on GRN/2026-27/00013 from Dell on 12 March, sat in rack R2 shelf S1 at the
Hyderabad warehouse for six weeks, was dispatched to ACME Technologies on
24 April, went in for repair in August, came back with a replacement unit, and
its warranty runs out on 24 April 2029.*

Everything unusual in this codebase exists to make that second kind of answer
possible and trustworthy.

### What it deliberately does not do

**No money.** No prices, no costs, no invoice amounts, no profit. You removed
this in v0.2 of the architecture, and it removed roughly a third of the
complexity — the whole eight-layer financial protection scheme collapsed to
five layers protecting contact details and bank account numbers.

This is worth noticing as a general lesson: **the cheapest way to secure data is
not to hold it.** A system that never stores a purchase price cannot leak one,
cannot compute a wrong margin from one, and does not need an audit trail for
who looked at one.

---

## 2. THE TEN DECISIONS THAT SHAPE EVERYTHING

These come from `docs/ARCHITECTURE.md` §0. They are the decisions that would be
expensive or impossible to reverse later, which is why they were settled before
any code was written.

### 2.1 The ledger is the truth; the stock table is a cache

There are two places that know how much stock exists:

- `InventoryTransaction` — every movement ever made, append-only
- `Inventory` — one row per product per warehouse with the current numbers

If they disagree, **the ledger wins**. The `Inventory` table exists only because
summing millions of ledger rows on every page load would be slow.

A nightly job recomputes `Inventory` from the ledger. If it finds a mismatch it
**raises an alert rather than fixing it**, because a mismatch means something
wrote stock outside the sanctioned path, and silently correcting the number
would hide the bug that produced it.

Think of the ledger as a transaction log and `Inventory` as a materialised view.

### 2.2 Warranty state is computed, never stored

The original brief listed `Under Warranty` and `Warranty Expired` as serial
number statuses, alongside `Sold` and `Available`. That merges two independent
things.

A unit is in exactly one **custody** state — where it physically is and who has
it. Separately, it is either inside or outside its warranty period, which is
purely a function of a date.

If warranty were a status, something would have to *write* to every sold serial
every night as warranties expired. Thousands of writes to asset records, forever,
to record the passage of time.

Instead the `Warranty` record stores `startDate` and `endDate`, and the status is
derived at read time:

```
now < endDate − 30 days  → ACTIVE
now < endDate            → EXPIRING_SOON
now ≥ endDate            → EXPIRED
```

No job touches it. Correcting a wrong date instantly fixes every report.

**The general rule: do not store what you can calculate.** Stored derived data
has to be kept in sync, and eventually it will not be.

### 2.3 Negative stock is prevented by the database

The obvious code is wrong:

```js
const row = await Inventory.findOne({ product, warehouse });
if (row.availableQuantity < qty) throw new Error('not enough');
row.availableQuantity -= qty;
await row.save();
```

Two requests for the last 10 units both read `10`, both pass the check, both
write `0`. You have dispatched 20 units you do not have. It passes every test,
because tests run one request at a time.

What we do instead:

```js
await Inventory.findOneAndUpdate(
  { tenantId, product, warehouse, availableQuantity: { $gte: qty } },
  { $inc: { availableQuantity: -qty } },
  { new: true, session },
);
```

The condition is *inside* the query. MongoDB matches and increments as one
indivisible operation. Whoever arrives second matches nothing and gets `null`
back — that is the "insufficient stock" error.

This is compare-and-swap. You have met it before as TOCTOU (time-of-check to
time-of-use) — the same bug as checking whether a file exists and then creating
it. The fix is always the same shape: **stop asking, and make the asking part of
the doing.**

A test in `grn.test.js` fires two simultaneous claims on the last 10 units and
asserts that exactly one succeeds.

### 2.4 MongoDB must run as a replica set

Posting a GRN changes six things: stock quantities, ledger rows, serial records,
serial history, purchase order tallies, and the GRN status. Either all of them
happen or none.

That needs multi-document transactions, and MongoDB only supports those on a
replica set — not on a standalone `mongod`.

The failure mode here is nasty: a standalone server **accepts** `startSession()`
and appears to work. Your code looks transactional and is not. You would discover
this the first time something failed halfway and left corrupt data.

So `config/db.js` runs a `hello` command at boot and **refuses to start** if the
deployment is not a replica set. Loud failure at startup beats a silent one three
months in. `docker-compose.yml` initiates a single-node replica set
automatically, and `/health/ready` reports transaction availability separately
from connectivity.

### 2.5 Document numbers come from an atomic counter

`PO-${count + 1}` produces duplicate purchase order numbers under concurrency.
Two requests count 41, both produce `PO-42`.

Instead there is a `Counter` collection and `findOneAndUpdate({ $inc: { seq: 1 } })`,
which is atomic. Numbers are scoped per financial year and per document type:
`PO/2026-27/00042`.

A test fires 50 concurrent requests and asserts 50 distinct numbers.

### 2.6 Soft delete needs partial unique indexes

Records are never really deleted — `deletedAt` is set instead. History matters.

But `unique: true` on `sku` plus soft delete means a deleted product squats on
its SKU forever. So every unique index carries:

```js
{ unique: true, partialFilterExpression: { deletedAt: null } }
```

Uniqueness applies among live records only.

**Serial numbers are the deliberate exception.** They are unique across all time
including deleted records, because reusing one would merge two physical units'
histories — and that history is what the system exists to provide.

### 2.7 One code path may change stock

`ledgerService.js` is the only file allowed to write to `Inventory`. Everything
else — GRN posting, dispatch, transfers, returns — calls into it.

That is what makes "every movement creates a ledger row" structurally true
rather than a convention people remember. **The code that changes quantities is
the code that writes ledger rows**, so there is no path that does one without
the other.

An ESLint rule enforces it (§6).

### 2.8 Multi-tenancy as a hook, not a feature

Every tenant-scoped collection carries `tenantId`, injected automatically by
`BaseRepository`. Today there is one company and no UI to create another.

You chose "possibly later — build the hook now," which was the right call. A
tenant discriminator costs a day now because it changes every unique index. After
Phase 8, with production data and twenty services, it is a rewrite.

### 2.9 Reject, do not silently ignore

When someone tries to sort by a field they cannot see:

```
GET /api/v1/vendors?sort=phone:asc
→ 403 RESTRICTED_FIELD_ACCESS_DENIED  + a WARNING audit entry
```

The tempting alternative is to drop the parameter quietly. That is worse: a
probe becomes indistinguishable from a normal empty result, and you lose the
signal that someone is testing your boundaries.

### 2.10 Omit, do not mask

When a user may not see a field, the field is **absent from the response** — not
`null`, not `"***"`.

`phone: null` across a list of 500 vendors still tells you which 40 have a phone
number on file. `phone: "***"` tells you the same thing *plus* the fact that
filtering is happening. Absence reveals nothing.

---

## 3. PHASE BY PHASE

### Phase 0 — Foundation

Repository, Docker, CI, and the pieces every later phase leans on.

**What matters here:**

- **MongoDB replica set** with automatic initiation (see §2.4)
- **`withTransaction` helper** — retries on transient conflicts, and provides an
  `onCommit` queue so audit entries and notifications run only after a successful
  commit. An audit write that fails must never roll back a stock movement that
  already happened.
- **Boot-time environment validation** via Zod. Wrong config exits immediately
  with a readable message instead of failing inside a request handler at 2am.
- **Centralised error handling** with stable machine codes (`INSUFFICIENT_STOCK`,
  `DUPLICATE_SERIAL`). The frontend and tests match on codes, never on message
  text, so wording can change freely.
- **Request context** via `AsyncLocalStorage` — carries request id, IP and actor
  ambiently, so the audit writer can reach them without threading four extra
  arguments through every function signature.

**Exit criterion:** a test transaction commits *and rolls back* correctly. Five
tests prove it, including that a failure after two successful writes leaves
neither behind.

### Phase 1 — Authentication and Access Control

**Tokens.** Two of them, doing different jobs:

- **Access token** — a JWT, 15 minutes, carries a snapshot of the user's
  permissions. Sent in the `Authorization` header. Short-lived because it cannot
  be revoked directly.
- **Refresh token** — opaque random bytes, 7 days, `HttpOnly` cookie. Stored
  **hashed** in the database, so a database dump yields no usable sessions.

**Rotation with reuse detection.** Every refresh issues a new token and marks the
old one used. If an already-used token is presented, that means it was stolen —
the legitimate holder rotated it, so whoever holds this copy should not. The
system revokes the entire token family, bumps `tokenVersion`, and writes a
`CRITICAL` audit entry.

**`tokenVersion` is the revocation mechanism.** Because permissions live inside
the token, demoting someone would normally have no effect until their token
expired. So any change to role, permissions, scope, status or password increments
`tokenVersion`, and every request compares the token's copy against the database.
A demoted user loses access on their next request.

**Permissions, not roles.** Nothing in the codebase asks "is this an Admin." Every
check is `requirePermission('POST_GRN')`. Roles are just named bundles of
permissions, stored as data. This is what lets you reshape a role from the UI
without a deployment.

Effective permissions = `role ∪ user grants − user denies`. **Denies always win**,
so an ambiguous configuration removes access rather than granting it — fail
closed.

**Privilege ceiling.** Two rules that separate real RBAC from decoration:

1. You cannot assign a role at or above your own rank
2. You cannot grant a permission you do not hold yourself

Without these, an Admin mints a role with `MANAGE_SUPER_ADMIN`, assigns it to
themselves, and the distinction between Admin and Super Admin is meaningless.

**Uniform login failures.** Wrong password, unknown email and locked account all
return the same message. Otherwise the login form is a free tool for discovering
which email addresses are real. The cost is what you experienced — as the
legitimate owner you were told nothing useful — and the standard answer is that
the *audit log* records exactly what happened while the *response* stays vague.

**Exit criterion:** a role × endpoint matrix suite, where expectations are
derived from the role definitions rather than hand-written. Change a role's
permissions and the test's expectations change with it, so the two cannot drift.

### Phase 2 — Master Data

Eight collections: Category, Subcategory, Brand, Manufacturer, Warehouse, Vendor,
Customer, Product.

**Generated, not written eight times.** `crudFactory.js` produces list, get,
create, update and delete for any entity from a config. The value is not saved
typing — it is that when Phase 3 added a GRN→Vendor reference, no vendor-specific
delete code needed to learn about it.

**Reference-in-use blocking.** Deleting a category that still has products
returns 409 naming the blocker and its count. The alternatives are worse:
cascading silently deletes your products, nulling the reference leaves products
the UI cannot render.

**Restricted fields, for real this time.** Vendor and Customer carry `phone`,
`email` and `bankDetails` as `select: false`. Five layers protect them (§5.7).

**Bank numbers masked even for the permitted.** `VIEW_VENDOR_BANK_DETAILS` shows
`••••9012` on list and detail screens. The full number comes from a separate
endpoint that writes a `WARNING` audit entry per call.

The reasoning: the permission answers "may this person confirm which account we
pay," and four digits answer that. A full number on a list screen ends up in
browser history and screenshots for no added benefit. Making the full read a
separate event means you can later answer *who looked at this account, and when*.

**CSV import is all-or-nothing.** Every row validated, every reference resolved,
and only then is anything written. A partial import is the worst available
outcome: you cannot tell which rows landed, re-running duplicates the successful
ones, and repairing it by hand across a few thousand products is a day lost.

### Phase 3 — Purchase Orders, GRN and the Ledger

Where stock becomes real.

**Draft and post are separate.** A GRN is entered at the dock over several
minutes. Half-entered stock must not be visible as available. Posting is the
single, irreversible moment when everything moves.

**Posting is one transaction** doing six things (§2.4). The exit criterion test
posts a two-line GRN where line 1 succeeds and line 2 fails on a duplicate
serial, then asserts that line 1's stock, its ledger row, the serial created
before the failure, its history event and the PO tally have **all** been rolled
back — and that the GRN is still DRAFT and correctable.

**Damaged is stock; rejected and short are not.** Damaged units go to their own
bucket — visible, countable, unsaleable — and leave via a vendor return or scrap
adjustment. Rejected goods are physically present but refused. Short goods never
arrived. Neither increases anything; both are recorded as a claim against the
vendor.

**Cancellation writes reversing entries.** The original rows stay and a reversal
points back at them. There is no screen anywhere that edits posted stock history,
because a ledger you can rewrite is not evidence of anything. Cancellation is
also refused once any unit has moved on, since unwinding would corrupt
everything that happened since.

**Purchase orders cannot be self-approved.** Otherwise the approval step is
theatre.

**Duplicate serials are reported all at once.** A pallet of 200 with three
duplicates surfaces all three rather than making the operator retry once per
duplicate. The unique index remains the real guarantee; the pre-check exists for
the error message.

---

## 4. HOW A REQUEST MOVES THROUGH THE CODE

This is the map. Once it is in your head, most confusion about "where does this
code belong" disappears.

A Warehouse Operator taps **Post** on a GRN.

```
POST /api/v1/grn/68f2.../post
```

Each layer answers exactly one question and trusts the layer above to have
answered its own.

| # | File | The one question it answers |
|---|---|---|
| 1 | `app.js` | Is this request safe to process at all? |
| 2 | `routes/v1/purchase.routes.js` | Which code handles this URL, and who may call it? |
| 3 | `middleware/authenticate.js` | Who is this? |
| 4 | `middleware/authorize.js` | May they do this? |
| 5 | `middleware/validate.js` | Is the input well-formed? |
| 6 | `middleware/queryGuard.js` | Are they sorting or filtering by something they cannot see? |
| 7 | `controllers/purchase.controller.js` | Translate HTTP into a function call |
| 8 | `services/purchase/grnService.js` | What does "posting a GRN" actually mean? |
| 9 | `services/shared/transaction.js` | All of it, or none of it |
| 10 | `services/inventory/ledgerService.js` | Change stock — and never without a ledger row |
| 11 | `repositories/*.js` | Fetch data, applying tenant scope and field permissions |
| 12 | `models/*.js` | What shape is the data, and what is structurally impossible? |
| 13 | `serializers/*.js` | What may *this particular person* see of the result? |
| 14 | `middleware/errorHandler.js` | Something threw — turn it into an HTTP response |

### What this buys you

**The route line is the whole access policy:**

```js
grnRouter.post('/:id/post', requirePermission('POST_GRN'), validate(...), controller.postGrn);
```

You never hunt inside a handler to discover who can call an endpoint.

**Controllers are three lines.** If one of mine grows an `if` about business
rules, that is a bug — the logic belongs one layer down.

**Services take plain values, not `req`/`res`.** `postGrn(actor, id)` can be
called from a script, a cron job or a test without inventing a fake HTTP
request. That is not an accident; it is the point of the separation.

**Services throw domain errors and never think about status codes.**
`throw new ConflictError(...)` becomes a 409 because `errorHandler` says so, in
one place.

### The rule for deciding where code goes

Ask: **which question is it answering?**

- "Can this vendor be received from?" → business rule → **service**
- "Is this a valid date?" → **validator**
- "Can this role do this?" → **route**
- "What shape is this record?" → **model**
- "Should this user see this field?" → **serializer**

And the more useful reverse test: **if you cannot state which single question a
piece of code answers, it is probably doing two things and wants splitting.**

---

## 5. ELEVEN CONCEPTS WORTH UNDERSTANDING PROPERLY

### 5.1 Transactions, and why `onCommit` exists

```js
await withTransaction(async ({ session, onCommit }) => {
  await applyMovement({ session, ... });
  await serialService.createForReceipt({ session, ... });
  onCommit(() => writeAudit({ ... }));
});
```

Three things to notice.

**`session` is threaded everywhere.** A database call that forgets it silently
escapes the transaction and survives a rollback. This is the hardest bug in this
class of system to find, which is why `applyMovement` throws immediately if
called without one.

**`onCommit` runs after the commit, not inside it.** Audit entries and
notifications belong there. An audit sink being briefly down must not roll back a
stock movement that physically happened, and a notification sent for a
rolled-back GRN is a lie.

**Retries.** MongoDB may abort a transaction under contention and label it
retryable. The correct response is to run the whole callback again, not to fail
the request.

### 5.2 Buckets

Stock sits in one of five buckets: `available`, `reserved`, `damaged`,
`inTransit`, `underService`. Total stock is the sum.

Why not a single number plus flags? Because the question a warehouse asks
constantly is *"why did available stock drop when total stock did not change?"*
A net-quantity ledger cannot answer it. Bucket-to-bucket movements can.

Ledger rows record `bucketFrom` and `bucketTo`, and a bucket-to-bucket move is
`direction: NEUTRAL` — total unchanged.

### 5.3 Append-only

`InventoryTransaction`, `AuditLog` and `SerialNumberEvent` have no update or
delete path. Mongoose hooks throw if you try:

```js
for (const op of ['updateOne', 'deleteOne', 'findOneAndUpdate', ...]) {
  schema.pre(op, (next) => next(new Error('append-only')));
}
```

Corrections are new rows pointing at what they correct, via `reversalOf`. Both
the mistake and its correction stay permanently visible.

This is not paranoia about malicious insiders. It is that an audit log which the
application can edit proves nothing, and a stock history that can be adjusted to
match a physical count hides the discrepancy you needed to investigate.

### 5.4 Default-deny at the schema

Restricted fields are declared `select: false`:

```js
phone: { type: String, select: false },
```

They are simply **absent** unless a query explicitly asks for them.

The reasoning is about failure modes. If sensitive fields were selected by
default and stripped on the way out, every new endpoint any developer writes for
the next three years is a leak until proven otherwise. One forgotten
`.lean()` and the field ships.

This way, a developer who has never read the access-control docs writes an
endpoint that returns **less** data than it should. That is the correct direction
to fail in.

### 5.5 The repository layer

Only `BaseRepository.selectRestricted(model, permissions)` may produce a
`+field` projection, and it requires the caller's permission set as an argument.

An ESLint rule blocks `.select('+` anywhere else in `src/`. It caught a real
violation in Phase 1 — `authService` was selecting `+passwordHash` directly.
Credential reads now live in `user.repository.js` as three named methods, so
**every place the application can read a password hash is visible in one file**.

### 5.6 Tenant injection

`BaseRepository` merges `tenantId` into every query. A service cannot leak across
companies by forgetting it, because the service never builds the final filter.

### 5.7 The five layers protecting a restricted field

Hiding a field in the response is not enough, because the field can be inferred
without ever appearing.

1. **Schema** — `select: false`, so it is absent by default
2. **Registry** — one file maps model → field → required permission, consumed by
   five different subsystems so they cannot disagree
3. **Repository** — the only place that may request it, and only with permissions
4. **Query guard** — rejects it as a sort, filter, search or groupBy key
5. **Serializer** — omits it from the DTO

Layer 4 is the one people forget. `?sort=phone:asc` orders records by a value you
cannot see; `?filter[phone][regex]=^98` tests it one prefix at a time. Both
extract the field without it ever appearing in a response body.

The frontend `PermissionGuard` sits **outside** this list on purpose, and says so
in its own source: it is presentation, not security. It stops honest users seeing
broken columns. It stops an attacker from nothing.

### 5.8 Derived status

Purchase order receiving status is computed from line tallies:

```js
if (totalSettled >= totalOrdered) this.status = 'RECEIVED';
else if (totalSettled > 0) this.status = 'PARTIALLY_RECEIVED';
```

Nobody types it in. A status that can be set by hand is a status that will
eventually disagree with the quantities beneath it.

Terminal states — `CANCELLED`, `SHORT_CLOSED` — are excluded, because those are
decisions, not tallies.

### 5.9 The serial state machine

A table of which transitions are legal, and 121 tests asserting every ordered
pair of statuses:

```js
AVAILABLE: ['RESERVED', 'IN_TRANSIT', 'DAMAGED', 'SCRAPPED', 'RETURNED_TO_VENDOR'],
RESERVED:  ['DISPATCHED', 'AVAILABLE'],
```

Notice what is **missing**: `AVAILABLE → DISPATCHED`. A dispatch must pass through
`RESERVED`, and claiming that reservation is an atomic operation. That is what
makes "a serial can never be dispatched twice" a database guarantee rather than a
hope.

The exhaustive test matters because it means a future edit cannot quietly widen
the table by one entry.

### 5.10 Idempotency

Posting the same GRN twice returns 409, not double stock. Retried requests,
double-clicked buttons and network timeouts followed by retries are all normal,
and an operation that moves physical goods must survive them.

### 5.11 404 versus 403

Out-of-scope records return **404, not 403**.

A 403 confirms the record exists. A warehouse operator at one site could
enumerate another site's GRN numbers by watching which ids come back "forbidden"
and which come back "not found."

---

## 6. THE GUARDRAILS

Two ESLint rules encode architectural invariants. Both exist because a rule that
lives only in a document degrades the moment someone new joins, or the moment you
return to the code in six months.

**Rule 1 — restricted-field projections.** `.select('+field')` is an error
outside `src/repositories/`.

**Rule 2 — the single write path.** Mutating methods on the `Inventory` model
are an error outside `src/services/inventory/`.

Adding Rule 2 produced a lesson worth remembering. My first attempt used a second
`no-restricted-syntax` block — and **silently disabled Rule 1**. ESLint flat
config resolves rules by name, last match wins, so a second block covering
overlapping files *replaces* rather than adds.

I noticed only because repositories suddenly failed lint. Had I written the new
rule for files the old one did not cover, nothing would have failed and Rule 1
would have quietly stopped working.

Rule 2 now uses `no-restricted-properties` — a different rule name — and both
were verified by planting a deliberate violation of each and watching them fire.

---

## 7. BUGS WE HIT, AND WHAT EACH TAUGHT

Worth reading as a set. Most were found by tests or by you running the thing,
which is the point.

### `sanitizeFilter` — a security control that was a trap

`mongoose.set('sanitizeFilter', true)` neutralises operator injection from user
input. It also cannot tell user input from a query a developer wrote, so it
wrapped every legitimate operator in `$eq`:

```
{ _id: { $nin: [...] } }             → { _id: { $eq: { $nin: [...] } } }
{ availableQuantity: { $gte: qty } } → { availableQuantity: { $eq: { $gte: qty } } }
```

The first broke your seed script with a `CastError`. The second is the guarded
update that prevents negative stock — it would not have thrown, it would simply
have stopped matching, and every inventory decrement from Phase 4 onward would
have failed as "insufficient stock" against a full warehouse.

**Lesson: a security control that cannot distinguish trusted from untrusted
callers is not a control, it is a trap.** Injection is now blocked at the
boundary where untrusted input becomes a filter, and code keeps its operators.

### Subcategory uniqueness — and indexes that do not replace

The shared factory declared a tenant-wide unique index on `name`, which would
have made "Switches" impossible under both Networking and Electrical.

Adding a narrower `{tenantId, category, name}` index alongside it **does not
help** — Mongoose creates both, and the broader one wins. The factory now takes
`uniqueName: false`.

**Lesson: a narrower constraint does not override a broader one. It has to not
exist.**

### A test passing for the wrong reason

The test asserting the API refuses to create TRANSIT warehouses used
`name: 'X'` — which fails the minimum-length rule. The assertion would have
passed even if the type restriction were deleted.

**Lesson: when a test passes, check it can fail.** A green test proving nothing
is worse than no test, because it buys false confidence.

### The customers page crash

Every master route rendered the same component type at the same position, so
React kept the state across navigation — including rows loaded for the previous
entity. A product row hit `r.customerType.replace(...)`, threw, and unmounted
the tree.

Three lessons in one bug:

**React renders first, then runs effects.** If render throws, no effect fires —
which is why the Network tab was completely empty. "No request at all" often
means a crash, not a fetching problem.

**Blast radius.** One undefined field destroyed the entire UI. Now the renderer
degrades one cell, and an ErrorBoundary contains anything that still throws.

**Check before theorising.** I confidently attributed your empty Network tab to
"effect dependencies" and was wrong. The console errors settled it in seconds.

### Docker, Vite, PowerShell

Three variations on the same theme: **something between you and the program
rewrote your input.** `VITE_API_PROXY` pointing at `localhost` inside a
container; PowerShell stripping quotes before `docker exec`; a zip that skipped
files and produced `ERR_MODULE_NOT_FOUND`.

**Lesson: suspect the transport before the destination.** And when an error names
a specific path, check that path first, before any theory.

---

## 8. WHERE EVERYTHING LIVES

```
backend/src/
├── config/          env.js (validated at boot), db.js (replica set check), logger.js
├── constants/       permissions.js, roles.js, restrictedFields.js, inventory.js
│                    ← the four files that define system behaviour as data
├── models/          schemas, indexes, what is structurally impossible
├── repositories/    data access + tenant scope + field permissions
├── services/        ALL business logic
│   ├── shared/      transaction, audit, counter, scope, crudFactory, referenceGuard
│   ├── inventory/   ledgerService ← the only writer of stock
│   ├── purchase/    poService, grnService
│   ├── serial/      serialService (state machine)
│   └── master/      the eight master-data entities
├── controllers/     HTTP in, HTTP out. Nothing else.
├── routes/v1/       URL → permission → validation → controller
├── middleware/      authenticate, authorize, validate, queryGuard, errorHandler
├── serializers/     what each person may see
├── validators/      Zod schemas
└── db/seed.js       idempotent, passwords generated per run

frontend/src/
├── lib/apiClient.js       axios + token refresh queue
├── app/store.js           Redux store
├── app/routes.jsx         routing + permission guards
├── constants/navigation.js  sidebar, permission-tagged
├── features/
│   ├── auth/              login, session, forced password change
│   ├── master/            masterConfig.js drives every list screen
│   └── dashboard/
├── components/            DataTable, PermissionGuard, ErrorBoundary
├── hooks/usePermission.js
└── layouts/AppLayout.jsx
```

### The four files where behaviour is data

If you want to understand or change how the system behaves, these come first:

| File | Defines |
|---|---|
| `constants/permissions.js` | every permission that exists |
| `constants/roles.js` | the seven default roles and what each holds |
| `constants/restrictedFields.js` | which fields need which permission |
| `constants/inventory.js` | buckets, transaction types, serial transitions |

Change one of these and behaviour changes everywhere, because everything reads
from them rather than hard-coding.

### One frontend file worth understanding

`lib/apiClient.js` has a single-flight refresh queue, and it is a **security
control, not an optimisation**.

Without it, five components hitting a 401 at once each fire a refresh. All but
the first replay an already-rotated token. The backend correctly reads that as
token theft and kills the entire session. The shared promise stops the client
tripping the server's own reuse detection.

---

## 9. WHAT IS STILL TO COME

| Phase | Scope |
|---|---|
| **4** | Stock adjustments with reason codes, physical count sessions, reconciliation job, drift alerts |
| **5** | Warehouse transfers — dispatch, in-transit, receipt |
| **6** | Serial number screens, QR/barcode, asset tags, per-unit history |
| **7** | Sales orders, reservation, dispatch notes, customer assignment |
| **8** | Warranty creation and alerts, service requests, repair and replacement |
| **9** | Customer and vendor returns, disposition |
| **10** | Document upload, dashboard |
| **11** | Reports, exports, notifications |
| **12** | Audit UI, load and penetration testing, Swagger, deployment |

Phase 4 is where the reconciliation job lands — the thing that checks `Inventory`
against the ledger nightly and alerts on drift.

---

## 10. GLOSSARY

| Term | Meaning here |
|---|---|
| **Actor** | The authenticated user, with resolved permissions and warehouse scope. Built once per request, carried everywhere |
| **Append-only** | No update or delete path exists. Corrections are new rows |
| **Bucket** | One of the five stock states: available, reserved, damaged, in transit, under service |
| **Derived status** | Computed from data, never stored. PO status, warranty status |
| **DTO** | The shaped object sent to the client, produced by a serializer. Never a raw database document |
| **GRN** | Goods Received Note. Records what physically arrived |
| **Guarded update** | A single query whose match condition is the precondition, making check-and-act atomic |
| **Idempotent** | Doing it twice has the same effect as doing it once |
| **Ledger** | `InventoryTransaction` — the authoritative record of every movement |
| **Materialised view** | `Inventory` — a cached summary of the ledger, rebuildable from it |
| **Partial index** | A unique index that applies only to rows matching a filter (here: `deletedAt: null`) |
| **Projection** | Which fields a query returns |
| **Restricted field** | One requiring a specific permission, `select: false` by default |
| **Scope** | Which warehouses a user may act on. Empty means all |
| **Serializer** | Turns a database document into a DTO, omitting what this person cannot see |
| **Soft delete** | Setting `deletedAt` instead of removing the row |
| **TOCTOU** | Time-of-check to time-of-use. The race between checking and acting |
| **Token version** | A counter that invalidates all outstanding access tokens for a user |
| **Transition table** | The legal state changes for a serial number |

---

## THE FIVE IDEAS WORTH KEEPING

If you take nothing else from this project:

**1. Make correctness structural, not remembered.**
The ledger rule is not "developers should write a transaction row." It is that
the only code able to change stock is the code that writes the row. Conventions
degrade; structure does not.

**2. Choose your failure direction.**
`select: false` means a careless developer ships less data, not more. Refusing to
boot against a standalone MongoDB means failing in ten seconds rather than three
months. Denies beating grants means ambiguity removes access. Every one of those
is a deliberate choice about which way to break.

**3. Do not store what you can compute.**
Warranty status, PO status, outstanding quantities. Stored derived data has to be
kept in sync, and one day it will not be.

**4. Reduce blast radius.**
One bad field should break one cell, not the application. One compromised refresh
token should kill one session family, not the account. You already know this from
not running services as SYSTEM.

**5. Check before you theorise.**
Every wrong guess in this project — mine and yours — came from reasoning about
what *should* be happening instead of looking at what *was*. Logs, the Network
tab, the actual file path in the error message. Ten seconds of looking beats ten
minutes of a confident, wrong explanation.

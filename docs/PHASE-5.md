# Phase 5 — file manifest

## Modified

- `.github/workflows/ci.yml`
- `backend/src/routes/v1/index.js`
- `backend/src/services/shared/referenceGuard.js`
- `backend/tests/integration/permissions.matrix.test.js`
- `frontend/eslint.config.js`
- `frontend/package.json`
- `frontend/src/components/table/DataTable.jsx`
- `frontend/src/constants/navigation.js`
- `frontend/src/features/master/masterConfig.js`

## New

- `backend/src/controllers/transfer.controller.js`
- `backend/src/models/WarehouseTransfer.js`
- `backend/src/routes/v1/transfer.routes.js`
- `backend/src/services/transfer/transferService.js`
- `backend/src/validators/transfer.schema.js`
- `backend/tests/integration/transfer.test.js`
- `docs/PHASE-5.md`
- `frontend/scripts/check-navigation.mjs`

## Deleted

None.

> No dependency changes — `docker compose restart backend` is enough.
> `frontend/package.json` gained a `check:nav` script. If you keep your own
> package.json, add `"check:nav": "node scripts/check-navigation.mjs"` to its scripts.
# Phase 5 — Warehouse Transfers

## Exit criterion

> Total system quantity conserved at every transfer state.

Met. `transfer.test.js → "holds total stock constant at every stage"` moves 300
of 1,000 metres from Hyderabad to Bengaluru and checks the system-wide total
after request, approval, dispatch, a partial receipt, and a final receipt with
damage. It is 1,000 every time.

## The problem

Stock on a truck is in neither warehouse. The two naive designs both break
anything that sums stock:

| Design | During the journey |
|---|---|
| Decrement source on dispatch, increment destination on receipt | goods **vanish** |
| Do both on dispatch | goods exist **twice** |

## The design

Goods move through a real, system-managed `TRANSIT` warehouse:

```
dispatch:  source      AVAILABLE   −300
           TRANSIT     IN_TRANSIT  +300

receipt:   TRANSIT     IN_TRANSIT  −300
           destination AVAILABLE   +290
           destination DAMAGED     +10
```

Four ledger rows per line minimum, signed changes summing to zero. Nothing is
ever created or destroyed; it is only ever somewhere.

## Decisions worth knowing

**Four steps, four permissions.** Request, approve, dispatch and receive are
separate permissions, and in practice usually separate people in separate
buildings. The separation is the control: whoever loads the truck should not be
the person confirming it arrived.

**Scope follows the physical act.** Dispatch requires the *source* warehouse in
your scope; receipt requires the *destination*. A Hyderabad operator cannot mark
goods received in Bengaluru, and gets a 404 rather than a 403 for trying.

**Requesters cannot approve.** Same rule as purchase orders.

**Missing goods stay visibly in transit.** A partial receipt leaves the
unreceived units in `TRANSIT` — not written off, not quietly absorbed. Goods
that go missing between two of your own buildings deserve exactly that much
noise until someone investigates.

**Serialized receipts use the serial lists as the quantities.** A clerk cannot
type "received 3" separately from scanning which three. Counts typed separately
could disagree with the units actually scanned; making the list *be* the count
removes the possibility.

**Serials are validated twice.** At request, for a helpful early error. At
dispatch, atomically, which is the check that matters — two approved transfers
can both name the same unit, and only one can actually put it on a truck.

**Cancellation only before dispatch.** Once goods are moving, the honest action
is to receive them at the destination, not to pretend they never left.

## How the "same unit on two trucks" case is actually prevented

Worth understanding, because it is not a lock in the application code.

Both dispatches run in transactions. Both read serial SN-1 as `AVAILABLE`. Both
try to write it as `IN_TRANSIT`. MongoDB detects that two transactions modified
the same document, aborts one with a `WriteConflict`, and labels it retryable.
The transaction helper from Phase 0 retries it — and on the retry, SN-1 reads as
`IN_TRANSIT` and is at the TRANSIT warehouse, so dispatch refuses.

No explicit lock anywhere. Snapshot isolation plus retry plus the state machine
produce the guarantee between them.

## Known gap

There is no way yet to write off goods lost in transit. They remain visibly in
`TRANSIT` indefinitely. The write-off path — which needs a reason, an elevated
permission, and serials moving to a terminal state — lands with returns and
scrapping in Phase 9. Deliberately deferred rather than half-built here.

## Two dead links found while shipping this phase

The Phase 5 change manifest listed `masterConfig.js` as unchanged, despite my
having edited it. Investigating showed the edit had matched nothing — and so had
the Phase 4 edit to the same file.

**Cause.** The customers-crash fix inserted `humanize()` between the closing `};`
of the config object and `function formatDate`. Both later edits were anchored on
exactly that adjacency. Python's `str.replace` does not fail when it finds
nothing; it returns the text unchanged. So:

- **Phase 4 shipped a Stock Counts sidebar link with no screen.** The router's
  catch-all redirected it to the dashboard. Nothing crashed, nothing logged.
- **The Users link had been dead since Phase 2.** The users API existed; the
  screen was never built.

Both were invisible for the same reason: a link that leads nowhere produces no
error anywhere.

**Fix — both the instance and the class.**

1. Both screens added, and every edit to a shared file now asserts that its
   anchor matched exactly once. An edit that matches nothing is an error, not a
   no-op.
2. `frontend/scripts/check-navigation.mjs`, run in CI, fails if any sidebar link
   has no screen, or if a link's permission differs from its screen's. Verified
   by running it against the Phase 4 release: it reports exactly the two dead
   links.

**The lesson worth keeping:** the dangerous bugs are the ones that fail
silently. A crash gets fixed the same day. A link that quietly redirects can ship
for three phases. When you find one, do not stop at fixing it — ask what would
have caught it, and build that.

It also explains why the change manifest earned its place. It was written so you
could see what changed; it ended up being how I noticed what *hadn't*.

## Verification

| | |
|---|---|
| Unit tests | 104 passing |
| Integration | conservation, four-row ledger, serial movement, partial receipt, double-dispatch, scope at each end, cancellation, post-transfer reconciliation |
| Permission matrix | 50 endpoints × 7 roles |
| Navigation check | 14 links, all routed — new, runs in CI |
| Lint | clean, both packages |

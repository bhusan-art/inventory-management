# 

**Phase 7 — file manifest Modified**

backend/src/routes/v1/index.js

backend/src/services/shared/referenceGuard.js

backend/tests/integration/permissions.matrix.test.js

frontend/src/components/table/DataTable.jsx

frontend/src/constants/navigation.js

frontend/src/features/master/masterConfig.js

New

backend/src/controllers/sales.controller.js

backend/src/models/DispatchNote.js

backend/src/models/SalesOrder.js

backend/src/models/Warranty.js

backend/src/routes/v1/sales.routes.js

backend/src/services/sales/dispatchService.js

backend/src/services/sales/salesOrderService.js

backend/src/utils/dates.js

backend/src/validators/sales.schema.js

backend/tests/integration/sales.test.js

backend/tests/unit/warrantyDates.test.js

docs/PHASE-7.md

Deleted



None.



No dependency changes — docker compose restart backend is enough.

# Phase 7 — Sales Orders and Dispatch

## Exit criterion

> Serial cannot be dispatched twice under concurrency; idempotent dispatch.

Both met. `sales.test.js` fires two concurrent confirmations at the last 10
units and asserts exactly one succeeds; a second test dispatches a unit, then
tries again and is refused by the transition table; a third retries a dispatch
with the same `Idempotency-Key` and gets the original note back rather than a
second shipment.

## What was delivered

**Sales orders** — draft, confirm (reserve), release, cancel, with derived
status from line tallies.

**Reservation** — stock moves AVAILABLE → RESERVED; serials are claimed
individually, either explicitly chosen or oldest-first.

**Dispatch notes** — goods leaving for a customer, with serial assignment,
customer ownership, and idempotency.

**Warranty creation** — one per serialized unit, dates computed at dispatch.

**Customer assets** — what a customer currently holds, with live warranty state.

## Decisions worth knowing

**Confirming decrements available; dispatching does not.**

This is the subtle one, and it has its own test. Confirm moves stock
AVAILABLE → RESERVED. Dispatch then removes it from RESERVED only. If dispatch
also decremented available, the stock would be removed twice and the second
decrement would eventually fail against a warehouse that visibly holds the
goods.

**Reservation is why `AVAILABLE → DISPATCHED` is not a legal transition.**

The reservation is an atomic claim on specific units. Two confirmations racing
for the same serial both try to write that document; MongoDB aborts one, the
Phase 0 retry helper runs it again, and the table refuses RESERVED → RESERVED.
"A serial cannot be dispatched twice" is therefore a database guarantee, not an
application promise.

**Unreserved serials are picked oldest-first.** It keeps stock rotating, so the
unit that has sat longest ships first and warranty periods are not quietly
consumed on a shelf.

**Reservations are never released on a timer.** Silently un-reserving stock a
salesperson is negotiating around causes worse problems than a stale
reservation. Phase 11 reports them; a human releases them.

**Warranty starts on dispatch, not on the order date.** Cover begins when the
customer has the goods.

**A dispatch can be cancelled; a delivery cannot.** Once delivered, the customer
holds the goods, and the honest route is a customer return (Phase 9). Pretending
the dispatch never happened would orphan the warranty and leave the customer
with units the system says it still owns.

## The month-end bug that did not ship

`setMonth` overflows rather than clamping: 31 January plus one month becomes
3 March, because 31 February does not exist. A warranty sold on the 31st would
have carried three days of free cover — quietly, on every month-end sale,
forever.

`addMonths` in `utils/dates.js` clamps to the last day of the target month, and
19 unit tests cover month-end, leap years, year boundaries and the exact example
from the architecture document (dispatched 2026-09-10 + 36 months → 2029-09-10).

Worth noting: nothing in the brief asked for this. It surfaced only from asking
"what does this function do on the 31st".

## Verification

|||
|-|-|
|Unit tests|130 passing (19 new on warranty date arithmetic)|
|Integration|reservation, concurrency, partial dispatch, double-dispatch, idempotency, cancellation, customer assets, post-sale reconciliation|
|Permission matrix|65 endpoints × 7 roles|
|Navigation check|17 links, all routed|
|Lint|clean, both packages|

## Not in this phase

Warranty records are created but there is no warranty management surface yet —
no alerts, no void, no service requests. That is Phase 8, which is mostly
reading what this phase now writes.


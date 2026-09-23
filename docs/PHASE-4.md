# 

\# Phase 4 — file manifest



\## Modified



\- `backend/package-lock.json`

\- `backend/package.json`

\- `backend/src/routes/v1/index.js`

\- `backend/src/routes/v1/purchase.routes.js`

\- `backend/src/services/shared/referenceGuard.js`

\- `backend/tests/integration/permissions.matrix.test.js`

\- `backend/worker.js`

\- `docs/SETUP.md`

\- `frontend/src/app/routes.jsx`

\- `frontend/src/constants/navigation.js`

\- `frontend/src/features/master/MasterListPage.jsx`

\- `frontend/src/features/master/masterConfig.js`

\- `frontend/src/layouts/AppLayout.jsx`



\## New



\- `backend/src/controllers/inventory.controller.js`

\- `backend/src/jobs/lowStock.js`

\- `backend/src/jobs/reconciliation.js`

\- `backend/src/jobs/scheduler.js`

\- `backend/src/models/Notification.js`

\- `backend/src/models/Setting.js`

\- `backend/src/models/StockCount.js`

\- `backend/src/services/inventory/adjustmentService.js`

\- `backend/src/services/inventory/stockCountService.js`

\- `backend/src/services/shared/notificationService.js`

\- `backend/src/validators/inventory.schema.js`

\- `backend/tests/integration/inventory.test.js`

\- `backend/tests/unit/adjustment.test.js`

\- `docs/PHASE-4.md`

\- `docs/WALKTHROUGH.md`

\- `frontend/src/components/ErrorBoundary.jsx`

\- `frontend/src/components/NotificationBell.jsx`



\## Deleted



None.



> `backend/package.json` changed: added `node-cron`. Run `npm install` in backend/, or rebuild the image.

# 

# Phase 4 — Adjustments, Stock Counts and the Watchdog

## Exit criterion

> 50 parallel requests for 10 units → exactly 10 succeed; ledger sums to inventory.

The concurrency half was proven in Phase 3. This phase adds the second half: a
reconciliation job that continuously checks the ledger against the projection,
plus the tests that prove it detects drift and refuses to hide it.

## What was delivered

**Stock adjustments** with mandatory reason codes, a permission ceiling, and a
`CRITICAL` audit entry every time.

**Bucket reclassification** — moving stock between available and damaged without
changing the total.

**Physical stock counts** — snapshot, record, post. One document, one posting,
every variance written at once.

**Reconciliation job** — nightly, recomputes each location from the ledger and
raises a `CRITICAL` notification on drift.

**Low-stock scanning** with deduplicated alerts and a suggested order quantity.

**Notifications** — model, service, API and a polling bell in the header.
Brought forward from Phase 11 because a watchdog with no way to report is not a
watchdog.

**Settings** — thresholds and windows as data rather than constants, with
defaults in code so a missing setting can never be why a stock movement fails.

## Decisions worth knowing

**The adjustment threshold is the LARGER of 10 units and 5% of stock.** With no
monetary values to threshold on, quantity relative to holding is the available
proxy — and it is the right one. A 200-unit correction on a 10,000-metre cable
drum is routine; the same correction on servers is not. Taking the larger means
low-volume products are governed by the unit floor and high-volume ones by the
percentage.

**Serialized products cannot be adjusted by quantity.** Setting "available = 3"
when five serial records exist leaves the quantity and the serial list
disagreeing, with no way to tell which two units vanished. Those are corrected
per unit, in Phase 6.

**Count sheets snapshot the system quantity.** A count takes hours. If the
system figure were read at posting time, any movement during the count would be
silently absorbed into the variance, and the count would "explain" a discrepancy
it never measured.

**Uncounted lines are left alone.** A line nobody counted is missing data, not
evidence that the stock is gone. Treating uncounted as zero would be the single
most destructive thing this system could do by accident.

**Completing a count needs `ADJUST\_INVENTORY\_UNLIMITED`.** Running one does not.
A count can legitimately post changes far beyond the per-adjustment ceiling, so
posting it has to be a deliberate act by someone who can be held to it. An
Inventory Manager can run the count; an Admin posts it.

**Reconciliation reports drift and does not repair it.** Auto-correcting would
make the symptom vanish every night while the cause kept writing bad data. A
quiet system that is wrong is worse than a noisy one that is right.

## Verification

|||
|-|-|
|Unit tests|104 passing — 17 of them on `validateAdjustment` alone, including the exact threshold boundary|
|Integration|adjustments, reclassification, counts, reconciliation, low stock, notifications|
|Permission matrix|44 endpoints × 7 roles|
|Lint|clean, both packages|

One integration test deliberately writes to `Inventory` directly, bypassing
`ledgerService`, to prove the watchdog notices. The ESLint rule makes that
impossible in `src/`, which is precisely why the test has to do it by hand.

## Not in this phase

Adjustments and counts have API endpoints and list screens, but no data-entry
forms yet — the count sheet is filled via the API. Forms arrive with the rest of
the operational UI in Phase 10.


# 

Phase 11 — file manifest

Modified

backend/package.json / package-lock.json — adds exceljs@^4, plus an overrides pin on uuid to clear its advisory

backend/src/models/Notification.js — per-user readBy replaces the shared readAt

backend/src/services/shared/notificationService.js — read state per reader

backend/src/controllers/inventory.controller.js — notification payload, unread count, mark-unread

backend/src/routes/v1/purchase.routes.js — /notifications/unread-count, /:id/unread

backend/src/routes/v1/index.js — mounts /reports

backend/tests/integration/permissions.matrix.test.js — 3 Phase 11 endpoints (104 in total)

frontend/src/components/NotificationBell.jsx — reads read rather than readAt

frontend/src/constants/navigation.js — Reports under Administration

frontend/src/app/routes.jsx — /reports

frontend/scripts/check-navigation.mjs — /reports is a standalone route

New

backend/src/services/reports/reportService.js

backend/src/services/reports/exportService.js

backend/src/controllers/reports.controller.js

backend/src/routes/v1/reports.routes.js

backend/src/db/migrations/001-notification-read-state.mjs

backend/tests/unit/exportSecurity.test.js

backend/tests/integration/reports.test.js

frontend/src/features/reports/ReportsPage.jsx

docs/PHASE-11.md

Deleted



None.



A dependency changed — exceljs is new and uuid is pinned by an override, so this needs a rebuild with renewed anonymous volumes (see docs/SETUP.md, "When a dependency changes"). No new permissions: VIEW\_REPORTS and EXPORT\_DATA were registered in Phase 1.



After copying the files

powershell

cd "C:\\Users\\sonub\\Downloads\\Inventory project\\inventory-management"

docker compose up -d --build --renew-anon-volumes backend worker frontend

docker compose exec backend npm run lint

docker compose exec backend npm test -- tests/unit

docker compose exec backend npm test -- tests/integration/reports.test.js 2>\&1 | Select-Object -Last 40

docker compose exec frontend npm run check:nav



Then run the notification migration once:



powershell

docker compose exec backend node src/db/migrations/001-notification-read-state.mjs



Expect 206 unit tests. Without the migration nothing breaks — existing notifications simply appear unread again, which is the safe direction.

# Phase 11 — Reports, Exports and Notifications

## Exit criterion

> An export cannot show a column the API would refuse; a notification addressed
> to a team cannot be buried by one person reading it.

Both met, each with tests that fail if broken.

## What was delivered

**Seven reports** — stock on hand, stock ageing, stock movement, warranty
expiry, service SLA, vendor performance, customer assets. All derived at read
time, each gated by its own permission.

**Exports** — CSV and XLSX, streamed, with restricted columns removed and every
download audited.

**Notifications** — per-user read state, unread counts, undo, filtering.

## The export is the fifth consumer

`restrictedFields.js` has carried this comment since Phase 1:

> \*One file, five consumers. The alternative — each consumer keeping its own
> idea of what is sensitive — is how these systems leak: the API hides a field
> correctly for two years and then a new CSV export quietly includes it.\*

It named five consumers and only four existed. This phase builds the fifth, and
it reads the same registry rather than keeping its own list.

**The column is removed, not blanked.** A column of empty cells tells the reader
the field exists and that they are not trusted with it — a small disclosure and
an invitation. An absent column says nothing, which is §2.10 (omit, do not mask)
applied to a spreadsheet.

**A column declares the field it reads, not the permission.** The registry
supplies the permission. So a field restricted *later* is covered automatically,
without anyone remembering the export exists.

**Rows are projected too.** Hiding the header while sending the value in the
payload would leak it to anyone who opens the network tab. The on-screen table
and the export are filtered by the same function, so they cannot disagree.

**Exports are audited, including the column list** — which is the evidence that
restricted columns were withheld. And `EXPORT\_DATA` is separate from
`VIEW\_REPORTS`: reading figures on screen and carrying a copy out of the
building are different decisions.

## CSV formula injection

A cell beginning `=`, `+`, `-`, `@` or a control character is **executed** when
the file opens in Excel or Sheets. A vendor named `=cmd|'/c calc'!A1` becomes
code running on the machine of whoever opens the export — and vendor names come
from our own forms, so the attacker is anyone who can type into any text field
we have. Leading characters are defused with an apostrophe.

The first version of that had a real bug, caught by its own test: it prefixed
**numbers** too, so a quantity change of `-5` exported as the text `'-5` and
stopped being a number. Only strings are suspect now.

Numeric-looking *strings* are still prefixed, deliberately. `+919876543210`
parses as a finite number, so exempting it would let Excel evaluate the cell and
drop the leading `+`, silently mangling every phone number in the file.

## Why XLSX and not CSV alone

Types survive. A serial number like `123456789012345` stays a string; in a CSV,
Excel decides it is a number and displays `1.23457E+14`, corrupting it
permanently on the next save. Dates arrive as dates rather than text that sorts
alphabetically. For a file whose entire purpose is to be opened in Excel, that
is not a nicety.

Both formats stream from a cursor rather than building an array first: a
50,000-row export assembled in memory is a latency spike and a way for one
request to exhaust the heap.

The `exceljs` dependency pulled a `uuid` with an advisory. Rather than accept
it, the call site was checked — exceljs calls `v4()` with no arguments, and the
advisory concerns v3/v5/v6 *when a buffer is supplied*, so it was unreachable.
It was still eliminated with an npm `overrides` pin, because "two vulnerabilities
we assessed as unreachable" decays into "two vulnerabilities nobody reads". The
override was then verified by writing and reading back a real spreadsheet.
`npm audit --omit=dev` reports zero.

## The notification bug this phase found

`Notification` had a single `readAt` field. That is correct for a notification
addressed to one person — and **most are addressed to a permission**. Every
holder of `ASSIGN\_SERVICE\_REQUEST` sees the same row, and with one shared field
the first person to open their inbox marked it read **for the entire team**.

A CRITICAL SLA alert would vanish from everyone else's unread list because a
colleague glanced at it. That is precisely the alert you cannot afford to lose,
and it was latent from Phase 4.

Read state is now `readBy: \[{ user, at }]` — a question about the pair
(notification, user), stored as one. `$addToSet` makes it idempotent, and
marking unread is possible, because "mark all read" is an easy mis-click.

A migration converts existing rows. Where `recipient` is set we know who read
it and the timestamp converts cleanly. Where it is null the reader is
unknowable, and those are left **unread for everyone** — a notification
surfacing twice is a nuisance, one silently buried is the failure being fixed.

```bash
docker compose exec backend node src/db/migrations/001-notification-read-state.mjs
```

## Reports worth a note

**Stock ageing covers serialized units only.** Bulk quantities have no identity,
so "how old is this cable" has no answer. Averaging receipt dates would invent a
number somebody would then act on.

**Vendor performance measures acceptance, not punctuality.** On-time delivery
needs a promised date the purchase order does not reliably carry; deriving one
from the order date would be a fabricated metric.

**An open ticket past its SLA counts as missed, not pending.** One still within
its window is `OPEN` — undecided, not a pass. Counting it as a pass would
flatter the figure.

## Verification

|||
|-|-|
|Unit tests|206 passing (14 new on export security: column filtering, registry consistency, CSV escaping and injection)|
|Integration|`reports.test.js` — menu filtering, per-report permission, restricted columns absent from screen, CSV and XLSX, export without `EXPORT\_DATA` refused, BOM, type preservation, audit, and five notification read-state tests|
|Permission matrix|104 endpoints × 7 roles|
|Navigation check|22 links, all routed|
|`npm audit --omit=dev`|0 vulnerabilities|
|Lint + guards|clean, both packages|

The test worth reading walks **every cell** of a generated XLSX looking for a
restricted phone number, rather than checking the headers. A value can hide in a
column you did not think to check.

## Still open

* The dispatch `TRANSACTION\_CONFLICT` from Phase 8 remains unexplained.
* Whether completing a stock count should require `ADJUST\_INVENTORY\_UNLIMITED`.
* No dark mode, though the validated palette is recorded.
* Scheduled report delivery by email — needs an email transport, which is a
Phase 12 deployment decision.


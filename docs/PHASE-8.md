# 

Phase 8 — file manifest

Modified

backend/src/controllers/serial.controller.js — the scan response now carries the unit's warranty, with derived status

backend/src/services/serial/serialQueryService.js — populates currentWarranty for the scan

backend/src/services/shared/referenceGuard.js — ServiceRequest → customer

backend/src/routes/v1/index.js — mounts /warranties and /service-requests

backend/src/jobs/scheduler.js — two new jobs (four in total)

backend/tests/integration/permissions.matrix.test.js — 17 Phase 8 endpoints added (82 in total)

frontend/src/app/routes.jsx — /service-requests/new and /service-requests/:id

frontend/src/components/table/DataTable.jsx — Phase 8 status tones; a rowLink may now decline a row

frontend/src/constants/navigation.js — new "Service" section

frontend/src/features/master/MasterListPage.jsx — optional permission-gated header action

frontend/src/features/master/masterConfig.js — warranties and service-requests screens

docs/WALKTHROUGH.md — Phase 4–8 sections, remaining-phases table refreshed

New

backend/src/models/ServiceRequest.js

backend/src/services/warranty/warrantyService.js

backend/src/services/warranty/serviceRequestService.js

backend/src/jobs/warrantyAlerts.js

backend/src/validators/warranty.schema.js

backend/src/controllers/warranty.controller.js

backend/src/routes/v1/warranty.routes.js

backend/tests/unit/serviceTransitions.test.js

backend/tests/integration/warranty.test.js

frontend/src/features/service/ServiceRequestDetailPage.jsx

frontend/src/features/service/NewServiceRequestPage.jsx

docs/PHASE-8.md

Deleted



None.



No dependency changes — docker compose restart backend worker frontend is enough. No new permissions either: VIEW\_WARRANTY, VOID\_WARRANTY, VIEW\_SERVICE\_REQUEST, CREATE\_SERVICE\_REQUEST, ASSIGN\_SERVICE\_REQUEST and WORK\_SERVICE\_REQUEST were all registered in Phase 1, so there is nothing to re-seed.



After copying the files

powershell

cd "C:\\Users\\sonub\\Downloads\\Inventory project\\inventory-management"

docker compose restart backend worker frontend

docker compose exec backend npm test -- tests/unit

docker compose exec backend npm test -- tests/integration/warranty.test.js

docker compose exec frontend npm run check:nav



The integration suite needs the replica set, so it only runs inside Docker — that is why it is a separate command from the unit tests.

# Phase 8 — Warranty and Service

## Exit criterion



> Warranty status is never stored; a service ticket cannot strand a unit in
> stock; a replacement does not restart the warranty clock.

All three met, each with a test that fails if the rule is broken.

## What was delivered

**Warranty register** — list, filter, summary, per-unit history, void, extend.
Status (active / expiring soon / expired) is computed on every read.

**Service requests** — the full ticket lifecycle: raise, assign, receive the
unit, inspect, send to a vendor, repair, return, replace, close — with an
exhaustive transition table and an embedded activity log.

**The under-service bucket** — a faulty unit physically in our building is
countable stock, in its own bucket, while remaining the customer's property.

**Replacement** — five coordinated moves in one transaction, with cover carried
over to the new unit.

**Alerts** — warranty expiry at 30, 15, 7 and 0 days, and a four-hourly SLA
breach scan. Four scheduled jobs now.

**Screens** — a warranty register, a ticket list, a raise-a-ticket form, and a
ticket page where the job is actually worked.

## Decisions worth knowing

**Entitlement is frozen when the fault is reported.**

`warrantyApplicable` and `warrantyEndDateAtRaise` are written onto the ticket at
raise time and never recomputed. A warranty can lapse while the unit sits in our
workshop; the customer reported the fault while covered, so the repair stays
covered. Deciding this at closing time would bill people for the length of our
own queue — and the bill would get larger the slower we were.

**A unit at the service centre is in stock.**

`receiveForService` adds 1 to the UNDER\_SERVICE bucket. It is in our building,
so a stock count will find it and must have somewhere to put it. Ownership and
custody are different questions, and the ledger answers custody.

Note the transaction type: `SERVICE\_OUT` is an *inbound* movement for us,
because the names are read from the unit's point of view — out of the customer's
hands and into service. The same convention gives `SERVICE\_RETURN` on the way
back.

**A ticket cannot be closed while we still hold the unit.**

Closing a received-but-not-returned ticket would leave 1 in the UNDER\_SERVICE
bucket with no open ticket explaining why — stock nobody can account for, and
the reconciliation job would report drift forever. `closeServiceRequest`
refuses, and the test asserts the bucket is untouched after the refusal.

**A replacement carries the original end date.**

This is the one people get wrong. A customer who bought 36 months of cover and
claims in month 30 is entitled to the remaining 6, not another 36. Restarting
the clock would hand out free cover on every claim, quietly, and the cost would
scale with the failure rate. `replaceUnit` copies `endDate` from the original
warranty, marks the original `CLAIMED\_REPLACED`, and links the two with
`previousWarranty`.

**The SLA clock runs from the report, not from the last change.**

Re-prioritising a two-day-old ticket to CRITICAL re-bases its deadline to four
hours *after the original report* — so it is immediately overdue, which is the
truth. A fresh clock would reward slow triage.

**Voiding is blocked while a ticket is open.**

Changing entitlement underneath a live claim changes the terms an engineer is
already working to. Close the ticket first.

**`UPDATE\_WARRANTY` does not let you void or extend.** Both change what the
customer is owed, so both sit behind `VOID\_WARRANTY`. The permission matrix
asserts that a role holding only `UPDATE\_WARRANTY` is refused.

**Sales can assign a ticket; only an engineer can work it.** Receiving,
progressing, repairing, replacing and closing are all `WORK\_SERVICE\_REQUEST`.

## The frontend cannot invent an action

The ticket serializer sends `allowedTransitions`, derived from the same
`SERVICE\_TRANSITIONS` table the service enforces. The action panel draws buttons
from that array, so a button the API would refuse is never rendered — and if one
were, the API would still refuse it. One table, two consumers, no drift.

The scan endpoint grew a `warranty` block for the same reason: "is this still
covered?" is the first question asked of a scanned unit, and it should not need
a second request.

## Verification

|||
|-|-|
|Unit tests|135 passing (8 new on the service transition table)|
|Integration|`warranty.test.js` — derived status, status filtering, frozen entitlement, SLA re-basing, bucket in and out, close-while-held refusal, transition enforcement, the full replacement flow, tenant isolation, notifications|
|Permission matrix|82 endpoints × 7 roles|
|Navigation check|19 links, all routed|
|Lint|clean, both packages|

The replacement test is the one worth reading: it asserts the new warranty's
`endDate` is byte-identical to the original's, both buckets end at zero, the
faulty serial reaches `REPLACED` with no customer, and the new unit's history
still shows the ticket raised against the old one.

## Not in this phase

A customer returning goods for credit or exchange outside a warranty claim is a
return, not a service ticket — Phase 9. Printable warranty certificates and
service reports are Phase 10. Nothing here writes to a warranty on a schedule,
and nothing ever will: that is the point of deriving the status.

## Open: the dispatch transaction conflict

`POST /dispatch-notes` intermittently returns 409 `TRANSACTION\_CONFLICT`
(MongoDB code 251, `NoSuchTransaction`) when the integration suite runs it
repeatedly. The same request passes every time in isolation.

What is established:

* It is not the dispatch logic. The test that fails in sequence passes alone.
* mongod logs **no aborted transaction** when it happens. A server-side abort
writes a `terminationCause: "aborted"` record; there is none. So the server
never opened the transaction the driver was asking about — the driver sent a
`txnNumber` the server had no record of.
* One real contributor was found and fixed: `nextDocumentNumber('DN')` ran
without the session, outside the transaction it sat inside. That also burned a
dispatch note number on every retry. Fixing it reduced the failure rate but
did not remove it.
* The environment is a factor. A majority write costs 50–160ms on this
filesystem, and mongod reports these transactions idle \~143ms against \~11ms
active — a wide window for a transient failure.

What is not established: why the driver and server disagree about the
transaction. Candidates not yet ruled out are server-session pooling returning a
session while an operation is still outstanding, and an implicit retryable write
advancing the transaction number on a recycled session.

Mitigations in place: `withTransaction` now makes 5 attempts with jittered
exponential backoff, and the test client honours the retry the API documents.
Neither is a fix. **This should be understood before the system carries real
dispatches**, because in production it surfaces as an occasional failed dispatch
that succeeds when the user clicks again — survivable, but it should be
explained rather than tolerated.

## Still open

Whether completing a stock count should require `ADJUST\_INVENTORY\_UNLIMITED`.
It currently does, which means a warehouse operator can start a count but not
finish one. Flagged in Phase 4 and still unanswered — worth a decision before
the system is in daily use.


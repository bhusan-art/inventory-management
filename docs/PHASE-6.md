# Phase 6 — Serial Numbers and Asset Tracking

## Exit criterion

> Every state pair asserted; duplicate serial rejected at both DB and service level.

Both were met in Phase 3 (121 transition pairs, duplicate detection). This phase
adds the surface that makes serial tracking usable: the scan endpoint, the
per-unit history page, labels, identifiers, and manual status correction.

## What was delivered

**The scan endpoint** — `GET /serials/scan/:serialNumber`. One round trip
returning product, location, customer, provenance, recent events, and the list
of transitions the unit may legally make next.

**Per-unit history** — the lifecycle timeline plus the stock movements behind it.

**Labels** — QR (payload: the serial number, nothing else) and Code128, plus a
printable sheet sized 50×25mm.

**Identifiers** — asset tag, MAC address and IMEI, each uniqueness-checked with
a message naming the clashing unit rather than an index.

**Status override** — manual correction with a mandatory reason and explanation.

**Opening-balance import** — CSV load of stock you already own at go-live.

**Global scan bar** — Ctrl+K from anywhere, straight to the unit.

## Decisions worth knowing

**The QR code contains the serial number and nothing else.**

The temptation is to encode product, warehouse and customer so a scan works
offline. Do not. A QR code is a public token stuck to a box that travels through
couriers, loading bays and skips, and anyone with a phone can read it. Encoding
the customer name tells a competitor who your customers are from a photograph of
a pallet.

The serial alone is meaningless to an outsider and sufficient to us: the scan
endpoint resolves it with authentication and permissions applied. Three unit
tests exist purely to stop a future "helpful" change adding more.

**A status override moves the quantity with it.**

This is the correctness point of the phase. Serialized stock has two
representations that must agree: the number in `Inventory` and the number of
serial records in the matching status. Changing a serial's status without moving
the quantity produces exactly the drift the Phase 4 reconciliation job hunts for
— except self-inflicted.

So `overrideStatus` resolves both statuses to their buckets via `STATUS_BUCKET`
and moves the unit between them in the same transaction. A new
`auditSerialConsistency` helper cross-checks the two representations, and an
integration test runs three overrides then asserts zero mismatches.

**The import creates stock, honestly.**

At go-live you already own 400 servers the system has never seen. Receiving them
as a fictional GRN would invent a purchase that never happened; creating serial
records alone would leave counts disagreeing with quantities.

So each unit becomes a serial record *and* a `STOCK_ADJUSTMENT` ledger entry
with reason `DATA_CORRECTION` — stock appearing with a truthful explanation of
where it came from. It creates stock from nothing, so it carries the same
ceiling as a large adjustment: `ADJUST_INVENTORY_UNLIMITED`.

**Anyone who can view serials can scan.** The scan is how a warehouse asks "what
is this thing in my hand". Gating it tighter would make the scanner useless to
the people actually holding it.

**Labels are HTML with print CSS, not PDFs.** Label printers and office printers
both handle a browser print dialogue, the page size is set in millimetres so it
matches the stock, and there is no PDF toolchain to carry.

## A broken button caught before shipping

The Label button was first written as a plain `<a href>` with the access token in
a query parameter. It would have 401'd every time: the token lives in memory and
travels in the `Authorization` header, and a new tab carries neither.

It now fetches the HTML through the API client, wraps it in a blob URL and opens
that. Putting a bearer token in a URL would have been worse than broken anyway —
URLs end up in history, proxy logs and referrer headers.

Worth recording because it is the same class as the Phase 5 dead links: a
feature that looks complete and fails only when used.

## Verification

| | |
|---|---|
| Unit tests | 111 passing, including 7 asserting the QR payload leaks nothing |
| Integration | scan, history, override-with-bucket-sync, consistency audit, identifiers, labels, import |
| Permission matrix | 57 endpoints × 7 roles |
| Navigation check | 15 links, all routed |
| Lint | clean, both packages |

## Note on this phase's build

The build container reset between phases and the working copy was lost. It was
restored from `inventory-management-phase5.zip` — which is the argument for the
per-phase deliverables being complete snapshots rather than diffs.

## Not in this phase

No UI for editing identifiers or overriding status — both are API-only for now,
with the list and detail screens read-only. Forms land with the rest of the
operational UI in Phase 10.

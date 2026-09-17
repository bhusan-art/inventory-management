# Phase 3 — file manifest



Differs from the Phase 2 zip. Use git status after unzipping for the authoritative list.



Modified

backend/eslint.config.js

backend/src/routes/v1/index.js

backend/src/services/shared/referenceGuard.js

backend/tests/integration/permissions.matrix.test.js

frontend/src/constants/navigation.js

frontend/src/features/master/MasterListPage.jsx

frontend/src/features/master/masterConfig.js

New

backend/src/constants/inventory.js

backend/src/controllers/purchase.controller.js

backend/src/models/Document.js

backend/src/models/GRN.js

backend/src/models/Inventory.js

backend/src/models/InventoryTransaction.js

backend/src/models/PurchaseOrder.js

backend/src/models/SerialNumber.js

backend/src/routes/v1/purchase.routes.js

backend/src/serializers/purchase.serializer.js

backend/src/services/inventory/ledgerService.js

backend/src/services/purchase/grnService.js

backend/src/services/purchase/poService.js

backend/src/services/serial/serialService.js

backend/src/services/shared/counterService.js

backend/src/services/shared/scopeService.js

backend/src/validators/purchase.schema.js

backend/tests/integration/grn.test.js

backend/tests/unit/counterService.test.js

backend/tests/unit/serialTransitions.test.js

docs/PHASE-3.md

Deleted



None.

# Phase 3 — Purchase Orders, GRN and the Inventory Ledger

## Exit criterion

> GRN posting is atomic: forced mid-transaction failure leaves zero partial state.

Met. `grn.test.js → "leaves zero partial state when a later line fails"` posts a
two-line GRN where line 1 is a clean bulk receipt and line 2 fails on a
duplicate serial, then asserts that line 1's stock movement, its ledger row, the
serial created before the failure, its history event, and the purchase order
tally have all been rolled back — and that the GRN is still DRAFT and postable
once corrected.

## What was delivered

**The ledger** — `InventoryTransaction`, append-only at the ODM level. Every
movement records `quantityBefore`, `quantityChange`, `quantityAfter`, the
buckets moved between, the reference document, and who did it.

**`Inventory`** — a materialized projection, one row per product per warehouse,
with five buckets (available, reserved, damaged, in transit, under service).

**`ledgerService`** — the single write path. Guarded atomic updates prevent
negative stock; `quantityBefore` is derived from what the database returned,
never from a prior read.

**Purchase orders** — approval (with self-approval blocked), cancellation,
short-close with a mandatory reason, and receiving states derived from line
tallies rather than set by hand.

**GRN** — draft/post separation, partial receiving, damaged and rejected splits,
serial capture with format validation, duplicate vendor-invoice control, and
cancellation by compensating entry.

**Serial numbers** — created at posting, moved through a state machine whose
transition table is exhaustively tested.

**Warehouse scope** — enforced as a mandatory query condition, returning 404
rather than 403 for out-of-scope records.

## Decisions worth knowing

**Damaged goods are stock; rejected and short goods are not.** Damaged units go
to their own bucket — visible, countable, unsaleable — and leave through a
vendor return or scrap adjustment. Rejected goods are physically present but
refused, and short goods never arrived; neither increases anything. Both are
recorded on the GRN as a claim against the vendor.

**Cancelling a posted GRN writes reversing entries; it does not delete.** The
original rows stay and the reversal points back at them. There is no screen
anywhere in this system that edits posted stock history — a ledger that can be
rewritten is not evidence of anything. Cancellation is also refused once any
unit from the receipt has moved on, because unwinding it would corrupt the
history of everything that happened since.

**A purchase order cannot be approved by the person who raised it.** Otherwise
the approval step is decoration.

**Duplicate serials are reported all at once.** Receiving a pallet of 200 with
three duplicates surfaces all three, rather than making the operator retry once
per duplicate. The unique index is still the real guarantee; the pre-check
exists for the error message.

## A second architectural guardrail

Phase 0 added an ESLint rule confining restricted-field projections to the
repository layer. Phase 3 adds the equivalent for stock: **nothing outside
`src/services/inventory/` may call a mutating method on the `Inventory` model.**

Business rule 2 — every movement creates a transaction — is only structurally
true if the code that changes quantities is the same code that writes ledger
rows. Without the rule it survives only as long as everyone remembers it, and
the failure mode (stock that silently disagrees with its own history) is among
the hardest bugs in this class of system to trace.

Implementing it surfaced a subtlety worth recording: the first attempt used a
second `no-restricted-syntax` block, which **silently disabled the Phase 0
rule** — flat config resolves rules by name, last match wins, so a second block
covering overlapping files replaces rather than adds. The inventory guardrail
now uses `no-restricted-properties`, a different rule name, and both were
verified to fire independently by planting a deliberate violation of each.

## Verification

|||
|-|-|
|Unit tests|87 passing (includes all 121 serial transition pairs)|
|Integration|GRN suite: atomicity, partial receipt, serials, duplicates, cancellation, scope, concurrency|
|Permission matrix|extended to 38 endpoints × 7 roles|
|Lint|clean, both packages, both guardrails verified firing|

Two concurrency tests are worth singling out: 50 parallel document-number
requests produce 50 distinct numbers, and two simultaneous claims on the last
10 units let exactly one succeed. A read-check-write in application code passes
neither.

## Not in this phase

No transfers between warehouses (Phase 5), no dispatch (Phase 7), no document
upload UI. The `Document` model exists and is referenced by PO and GRN, but the
upload endpoint lands with the rest of document management in Phase 10.


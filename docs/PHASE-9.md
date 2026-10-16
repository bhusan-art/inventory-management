# 

Phase 9 — file manifest

Modified

backend/src/routes/v1/index.js — mounts /customer-returns and /vendor-returns

backend/src/services/shared/referenceGuard.js — CustomerReturn → customer, VendorReturn → vendor

backend/tests/integration/permissions.matrix.test.js — 14 Phase 9 endpoints added (96 in total)

frontend/src/app/routes.jsx — /customer-returns/:id

frontend/src/components/table/DataTable.jsx — Phase 9 status tones

frontend/src/constants/navigation.js — Customer Returns and Vendor Returns under Service

frontend/src/features/master/masterConfig.js — both return registers

New

backend/src/constants/returns.js

backend/src/models/CustomerReturn.js

backend/src/models/VendorReturn.js

backend/src/services/returns/customerReturnService.js

backend/src/services/returns/vendorReturnService.js

backend/src/validators/returns.schema.js

backend/src/controllers/returns.controller.js

backend/src/routes/v1/returns.routes.js

backend/tests/unit/returnTransitions.test.js

backend/tests/integration/returns.test.js

frontend/src/features/returns/CustomerReturnDetailPage.jsx

docs/PHASE-9.md

Deleted



None.



No dependency changes and no new permissions — VIEW\_RETURN, CREATE\_RETURN, UPDATE\_RETURN, DELETE\_RETURN, APPROVE\_RETURN and SET\_DISPOSITION were all registered in Phase 1, so there is nothing to re-seed.



After copying the files

powershell

cd "C:\\Users\\sonub\\Downloads\\Inventory project\\inventory-management"

docker compose restart backend worker frontend

docker compose exec backend npm run lint

docker compose exec backend npm test -- tests/unit

docker compose exec backend npm test -- tests/integration/returns.test.js 2>\&1 | Select-Object -Last 30

docker compose exec frontend npm run check:nav



Expect 167 unit tests. npm run lint now runs ESLint plus both architectural guards, so it is the single command that checks the structural rules.

# 

# Phase 9 — Returns

## Exit criterion

> Returned goods are never sellable on arrival; a disposition is a ledger
> movement, not a status change; the ledger and the serials never disagree.

All three met, each with a test that fails if it breaks.

## What was delivered

**Customer returns (RMA)** — raise, approve, receive into quarantine, inspect,
disposition, close. Four dispositions: restock, quarantine, scrap, return to
vendor.

**Vendor returns (RTV)** — draft, approve, send, close. Can draw from the
damaged bucket (a faulty unit) or the available bucket (an over-delivery).

**The bridge between them** — a customer return whose goods are dispositioned
`RETURN\_TO\_VENDOR` can raise the vendor return directly, linking both documents
so a unit's history reads customer → us → vendor.

**Screens** — both registers, plus a return page where receipt and inspection
actually happen, and a disposition queue.

## Decisions worth knowing

**Returned goods land in DAMAGED, never AVAILABLE.**

This is the whole phase in one line. A return is the only flow where stock
arrives whose **condition is unknown** — everything else enters through a GRN
where someone at the dock inspected it and said how much was good. A customer
return arrives in a box with a complaint attached.

So the goods are quarantined: counted, visible, and unsellable until a human
looks. Restocking on arrival would mean a faulty unit could ship to the next
customer before anyone opened the box. `STATUS\_BUCKET.RETURNED\_BY\_CUSTOMER` was
already `'DAMAGED'` in the Phase 0 constants — this phase is where that decision
pays off.

**Three quantities per line, all different, all kept.**

`requestedQuantity` is what the customer claims they are sending.
`receivedQuantity` is what arrived. The dispositioned total is how much has been
decided on. Collapsing them would destroy two facts somebody asks about: that a
customer claimed five and sent four, and that two of the four are still on the
inspection bench. `shortfall` and `pendingQuantity` are both derived.

**`RETURN\_TO\_VENDOR` moves nothing.**

The first draft of this phase had it take the unit out of stock and set the
serial to `RETURNED\_TO\_VENDOR`. That was wrong, and wrong in a specific way: the
quantity would have stayed in the DAMAGED bucket while the serial said it had
left — exactly the drift the nightly reconciliation job exists to report, caused
by us.

The goods are still in our building until the vendor return is approved and
shipped. So the disposition earmarks the unit, leaves it in quarantine, and
`sendVendorReturn` performs the one physical movement and the one ledger
movement together. A unit test asserts the disposition table and
`STATUS\_BUCKET` agree about which dispositions leave stock, so the two cannot
drift apart again.

**QUARANTINE is a decision, not the absence of one.**

"Held pending vendor advice" and "nobody has looked at this yet" are different
states and the system distinguishes them. Setting QUARANTINE moves no stock but
clears the pending count, because a human has now looked.

**A return cannot be closed with stock still awaiting a decision.**

Closing early would leave units in the DAMAGED bucket with no open document
explaining why they are there — unaccountable stock, and drift reported every
night. Same reasoning as refusing to close a service ticket while we still hold
the unit.

**Receiving voids the warranty.**

The customer no longer has the thing, so the cover on it ends. The void reason
names the return number, so it never looks like an unexplained void sitting on
the warranty record.

**The dispatch note is optional.**

A customer returning a unit two years later may not have the paperwork, and
refusing the return because *our* reference is missing would make our problem
theirs. When it *is* supplied, the service checks the quantity against what that
note actually shipped and refuses a return for goods that were never sent.

**Nothing moves until the irreversible step.**

A vendor return draft does not touch stock, for the same reason a GRN does not
add stock until it is posted: a document being prepared over an afternoon must
not make a shelf lie about what is on it. The draft-time stock check is a
courtesy for a better error message; the guarded decrement in `applyMovement` is
what actually prevents sending goods we do not hold.

**A replacement from a vendor arrives as an ordinary GRN.**

`expectReplacement` is a flag, deliberately not a workflow. When the replacement
turns up it is goods at the dock needing inspection, which is what a GRN is.
Modelling it as a return that un-returns itself would invent a second receiving
path with none of the GRN's checks.

**Four permissions, because four different people are involved.**

Raising a return is `CREATE\_RETURN`; approving it is `APPROVE\_RETURN`, so the
person who raises one cannot authorise it. Receiving is `CREATE\_GRN` — it is the
moment stock changes, so it belongs to the people who handle goods. And
deciding a disposition is `SET\_DISPOSITION`, separate from all of them, because
it is the one that can quietly put a faulty unit back on the shelf.

## Verification

|||
|-|-|
|Unit tests|167 passing (17 new: both workflow tables asserted pair by pair, plus the disposition/bucket agreement)|
|Integration|`returns.test.js` — quarantine on arrival, warranty voiding, shortfall, idempotent receipt, bulk stock, all four dispositions, split dispositions, close-while-pending refusal, vendor return from both buckets, the serial dead end, the customer→vendor bridge, and a reconciliation check|
|Permission matrix|96 endpoints × 7 roles|
|Navigation check|21 links, all routed|
|Lint + guards|clean, both packages|

The reconciliation test is the one worth reading: it runs a full cycle —
dispatch, return, receive, restock one unit, scrap another — and then asserts
the nightly job reports **no drift**. Returns are the flow most likely to
desynchronise the ledger from the `Inventory` projection, so that assertion is
the real exit criterion.

## Not in this phase

Credit notes and refunds. The system deliberately holds no pricing, so what a
return is *worth* is not its question — only where the goods are. Printable
return notes are Phase 10.

## Still open

* The dispatch `TRANSACTION\_CONFLICT` from Phase 8 (see `PHASE-8.md`) is
unexplained and unchanged.
* Whether completing a stock count should require `ADJUST\_INVENTORY\_UNLIMITED`.
Flagged in Phase 4, still unanswered.


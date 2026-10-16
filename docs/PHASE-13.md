# 

Phase 13 — change manifest



Frontend only. No backend code changed, no schema changes, no migrations, no new dependencies.



Unzip the snapshot over C:\\Users\\sonub\\Downloads\\Inventory project\\inventory-management.



New files

Path	What it is

frontend/src/components/form/fields.jsx	Field primitives: text, textarea, number, select, checkbox, reference, address, key/value, racks.

frontend/src/components/form/EntityForm.jsx	One form for every entity, driven by config descriptors. Attaches server field errors to the inputs that caused them.

frontend/src/components/ConfirmDialog.jsx	Confirmation that performs the request itself, so a refusal is shown in the dialog with the record still visible. Optional mandatory reason.

frontend/src/features/inventory/InventoryPage.jsx	Inventory list with stock adjustment.

frontend/src/features/inventory/StockAdjustDialog.jsx	Add / remove / set exactly, with a before-and-after preview.

frontend/src/features/purchasing/PurchaseOrderFormPage.jsx	Raise a purchase order with line items.

frontend/src/features/purchasing/PurchaseOrderDetailPage.jsx	Approve, cancel, and open a receipt against an order.

frontend/src/features/purchasing/GrnFormPage.jsx	Receive goods, with serial capture for serialized products.

docs/PHASE-13.md	This phase in full.

backend/scripts/add-stock.mjs	The stopgap from before this phase. Still useful for bulk opening balances.

Modified files

Path	Change

frontend/src/features/master/masterConfig.js	fields descriptors for all seven master entities; update/remove permissions; a new subcategories screen; header actions and a row link for purchasing.

frontend/src/features/master/MasterListPage.jsx	New / Edit / Delete, each gated by permission.

frontend/src/components/table/DataTable.jsx	Optional rowActions column.

frontend/src/app/routes.jsx	Routes for /purchase-orders/new, /purchase-orders/:id, /grn/new, /inventory.

frontend/src/constants/navigation.js	Subcategories link.

frontend/src/features/audit/AuditLogPage.jsx	Survives a 200 carrying an unexpected body — a proxy's HTML error page crashed the screen.

After unzipping

powershell

docker compose up -d --build --renew-anon-volumes



No npm install needed — no new dependencies. Then:



powershell

docker compose exec backend npm test -- tests/unit     # expect 258

docker compose exec backend npm run lint

docker compose exec frontend npm run lint

docker compose exec frontend npm run check:nav          # expect 24 links

How to put stock in, through the interface

Categories → New. A product needs one.

Products → New. Choose Bulk quantity or Serialized; serialized units need a real serial number each, for life.

Warehouses → New.

Vendors → New.

Purchase Orders → New order. Pick the vendor, the destination and the lines. It is created as a draft and moves no stock.

Open the order → Approve. Nothing can be received until this happens.

Receive goods from the order. Quantities prefill from what is outstanding and all stay editable. Serialized lines want one serial per accepted unit — the counter shows how many are still needed, and a barcode scanner's Enter adds one.

Leave "Post immediately" ticked. Posting is what moves the stock.

Inventory now shows it.



For an opening balance — what is already on your shelf — skip the paperwork: Inventory → Adjust stock, choose Add to stock, and give a reason. Check the Current → After line before confirming: the API stores an absolute level, which is why that preview exists.



What still has no create screen



Sales orders, dispatch notes, transfers, stock counts, returns and users. This phase built the inbound path. The outbound path is the same pattern and roughly the same amount of work again.

# Phase 13 — Data Entry

## Why this phase exists

Phase 12 shipped a system with a complete, tested API and **no way to put
anything into it**. Every screen was a read-only list. The entire application
contained one create button:

```js
headerAction: { to: '/service-requests/new', label: 'Raise a ticket', ... }
```

The master-data configs even declared `permissions.create` for each entity —
and `MasterListPage` never read it. Twelve phases of backend with a frontend
that had only ever learned to display.

This was found by the plainest question possible: *where do I add stock?*

## Exit criterion

> Every workflow the API supports can be driven from the interface, and the
> screen that changes stock makes the change visible before it is committed.

\---

## One form, not eight

Eight hand-written forms drift from the Zod schemas they post to, in eight
directions. So fields are **descriptors in the config** — the same file that
already drives the sidebar, the routes and the table columns — and one
`EntityForm` renders them.

```js
{ name: 'sku', label: 'SKU', type: 'text', required: true, max: 40, uppercase: true }
```

Adding a field type is a change in one file and it works everywhere.

**Validation stays on the server.** The client checks `required` only — enough
to avoid a wasted round trip. A second copy of the Zod rules in the browser
would eventually disagree with the real ones, always in the direction of
accepting something the API then rejects.

`fieldErrors()` had existed in the API client since Phase 1 with **no caller**.
It maps the server's `body.productCode` back to `productCode`, which is what
attaches "HSN must be 4-8 digits" to the HSN input instead of dumping
"Validation failed" at the top and leaving the user to hunt.

Conditional fields come from the same place: `serialFormatPattern` has
`when: (v) => v.productType === 'SERIALIZED'`, because the server refuses that
combination outright and offering a field that will be rejected is worse than
not offering it.

\---

## The bug that only a browser could find

The form **crashed on open**. Lint clean, build clean, 258 backend tests green.

`initialValues` set every untouched field to `null`. The array fields are
written `function KeyValueField({ field, value = \[], onChange })` — and a
**default parameter only fires for `undefined`, never for `null`**. So they
received null and died on `.length` the moment the dialog rendered.

```
console errors: \[ "TypeError: Cannot read properties of null (reading 'length')" ]
```

This is the Phase 11 XLSX lesson again, in a different costume: the suite
tested the *decision* and never the *act*. A headless Chromium now opens every
screen and every create form and fails on any console error, which is how the
remaining work was checked rather than assumed.

\---

## Stock, and the number that is not what it looks like

`POST /inventory/adjust` takes `newQuantity` — an **absolute level, not a
change**. A box labelled "Quantity" beside an existing figure of 1,200 reads as
"add this much" to almost everyone, and typing 50 would silently destroy 1,150
units of recorded stock with a valid, audited, irreversible write.

So the dialog:

* asks explicitly whether this is **add / remove / set exactly**
* reads the current level for that product, warehouse *and bucket*
* shows `Current 1200 → After this adjustment 1250` before anything is sent
* refuses to submit anything that would go below zero
* computes the absolute figure itself, so the API contract is unchanged

Verified by driving it: ADD 50 against 1200 previews 1250; switching to SET
shows 50 and not 1250; REMOVE 5000 disables the button; and the request body
carries `newQuantity: 1500` for ADD 300 — absolute, as the server expects.

A reason is mandatory. An adjustment is the only way stock moves without a
document behind it, and "where did 400 metres go" has to have an answer —
`PHYSICAL\_COUNT` and `THEFT` being very different ones.

\---

## Receiving goods

The screen is built around the three things that go wrong in a real receipt.

**What arrived is not what was ordered.** Lines prefill from the order's
outstanding quantity because that is usually right, and every number stays
editable. A screen that assumes the delivery matches the paperwork forces the
receiver to lie to it.

**Accepted + damaged + rejected must equal received.** The server refuses
otherwise; discovering that after typing forty lines is miserable. Accepted is
computed and shown per line as the numbers are typed.

**A serialized product needs one serial per accepted unit — exactly.** The
count is shown against the requirement (`2 / 7`), duplicates are caught at the
input rather than by a unique-index violation that would reject the whole
receipt over one mis-scan, and Enter adds a serial instead of submitting the
form, because that is what a barcode scanner sends.

Creating a receipt does not move stock; posting it does. That separation is
deliberate, so the "post immediately" checkbox says what it does rather than
hiding it. If the post fails the GRN still exists, and the message says so and
where to find it instead of implying nothing happened.

\---

## The chain had a missing link

A purchase order is raised in `DRAFT`. Nothing can be received against it until
it is `APPROVED`. There was **no screen to approve one** — so the goods-receipt
screen's order dropdown would have been permanently empty with no visible
reason.

The purchase order detail page closes that, and keeps the permissions apart:
`CREATE\_PURCHASE\_ORDER` raises one, `APPROVE\_PURCHASE\_ORDER` approves it. The
person who asks for stock should not be the only person who agrees to it.

Cancelling asks the operator for a reason, which the endpoint requires. The
first version of this passed a hardcoded string — a canned reason typed by the
developer answers nobody's question six months later.

\---

## Two dead ends closed

**Subcategories had no screen.** The backend served them, the product form
offered the dropdown, and it could only ever say "None exist yet — create one
first" with nowhere to go. Now a screen and a nav entry, so the sentence is
true.

**The purchase-order row linked to a route that did not exist.** It would have
fallen through the router's catch-all and silently redirected to the dashboard —
the exact failure `check-navigation.mjs` was written for, except that guard only
covers sidebar links and not row links.

\---

## Small things that matter in use

* Escape closes every dialog. It was missing from the adjustment dialog, and a
modal that ignores Escape when its neighbours honour it is the kind of
inconsistency people blame on themselves.
* Code fields uppercase as you type, because the server uppercases them anyway
and the value you see should be the value that gets stored.
* An empty number box is `null`, not `0`. Sending 0 for "I did not set a
reorder level" turns a blank into a deliberate-looking figure the low-stock
report acts on.
* A reference that fails to load renders as a disabled select saying so. An
empty dropdown is indistinguishable from "there are none yet", which sends
someone off to create a record that already exists.
* The same product twice on one purchase order is flagged. The server allows
it; it is almost always two lines that each look right and together order
double.
* Deleting asks first, and the dialog performs the request itself so a refusal
— a category that still has products — is shown *there*, with the record
visibly still present.

\---

## Verification

|||
|-|-|
|Backend unit tests|258 passing, unchanged — this phase touched no backend code|
|Lint + guards|clean, both packages|
|Navigation check|24 links, all routed|
|Build|clean|
|Browser sweep|19 screens visited, every create form opened, **zero console errors**|
|Driven flows|master-data create / edit / delete, product form with server-side field errors, PO raise → approve → cancel-with-reason, GRN prefill from PO + serial capture + arithmetic, stock adjust in all three modes|

The browser checks run against a stub API rather than the real stack, so they
prove the interface behaves — not that the endpoints agree with it. The shapes
were read from the Zod schemas and serializers rather than assumed, but the
first real run against Docker is still the one that counts.

\---

## Still open

Unchanged from Phase 12, and none of it was touched here:

* The dispatch `TRANSACTION\_CONFLICT` from Phase 8 remains unexplained.
`scripts/load-test.mjs` is the instrument; it has not been run.
* Whether completing a stock count should require `ADJUST\_INVENTORY\_UNLIMITED`.
* No email transport.
* No dark mode.

New, and honest about it:

* **Sales orders, dispatch notes, transfers, stock counts, returns and users
still have no create screens.** This phase built the inbound path — master
data, purchasing, receipt, adjustment — because that is what "where do I add
stock" needed. The outbound path is the same pattern and the same amount of
work again.
* `add-stock.mjs` is now redundant for everyday use but kept: it is still the
fastest way to load an opening balance in bulk, and it works headlessly.


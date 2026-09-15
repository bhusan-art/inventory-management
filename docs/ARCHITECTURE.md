# Enterprise Inventory, Warehouse, Serial Number and Warranty Management System
## STEP 1 DELIVERABLE — Architecture and Database Design

Version 0.2 — pricing and financial tracking removed. For review and approval.

---

## 0. WHAT CHANGED IN v0.2, AND WHY

You asked to remove pricing completely and keep this as pure inventory software.
That is a larger change than deleting some fields, so here is exactly what it
removed, what it simplified, and the three places where I kept a mechanism alive
even though its original justification is gone.

### 0.1 Removed entirely

- All monetary fields: purchase price, cost price, selling price, MRP, discounts,
  GST amounts, invoice totals, freight, round-off, outstanding balances, credit
  limits, payment status, opening balances.
- Profit, margin, revenue, and inventory valuation — every concept and every
  report built on them.
- The `Purchases` collection (vendor bill). With amounts gone, it held only a
  vendor invoice number and date, which the GRN already needs to carry. One fewer
  collection, one fewer join, one fewer sync problem.
- Financial dashboards, financial reports, financial exports, financial audit log
  views, and the entire `VIEW_PRICING` / `VIEW_PROFIT` / `EXPORT_FINANCIAL_DATA`
  permission family.
- Moving weighted average cost maintenance on every receipt.
- The money utility layer, integer-paise handling, and GST calculation engine.

### 0.2 Renamed, because the old names implied money

| Was | Now | Reason |
|---|---|---|
| `SalesInvoice` | `DispatchNote` | goods leaving with serials, no amounts — a delivery challan |
| `Purchases` | *(removed)* | folded into GRN's vendor challan reference |
| Sales pricing fields | *(removed)* | — |

`SalesOrder` keeps its name: it is still a customer demand document that reserves
stock, it just no longer carries values.

### 0.3 The role set changed

`Accounts Team` had exactly one purpose in the original design — financial
visibility — and now has none. Removing it leaves a real gap on the operational
side, where the brief had no role for the person who physically receives goods.

**Decision:** seven seeded roles.

| Role | Exists to |
|---|---|
| Super Admin | full control, including other admins and security settings |
| Admin | full operational control |
| Inventory Manager | stock accuracy, adjustments, transfers, warehouse setup |
| Warehouse Operator | receive material, post GRNs, pick and pack, scan serials |
| Sales & Dispatch | customer orders, dispatch, customer-facing warranty |
| Service Engineer | service requests, repairs, replacements |
| Viewer | read-only |

Roles remain fully data-driven, so this is seed data you can change from the UI.

### 0.4 Three mechanisms I kept alive despite pricing being gone

**1. The sensitive-field registry (much smaller, still there).**
Not everything sensitive was financial. Vendor bank details, user contact details,
and customer contact details all still warrant field-level control, and the
registry costs almost nothing now that it has four entries instead of forty. It
also means that if you ever add pricing back — for one report, for one role — the
enforcement path already exists and is already tested. Rebuilding it later, after
thirty endpoints exist, is the expensive version.

**2. Default-deny at the schema level (`select: false`).**
Kept for the same reason. A developer who forgets about access control ships an
endpoint that returns less, not more.

**3. The query guard on sort/filter/search.**
Now guarding contact details rather than prices, but the inference attack is
identical in shape and the middleware is already written into the pipeline.

### 0.5 Everything else you approved, confirmed

- Warranty state is derived from `endDate`, never stored on the serial number.
- The ledger is authoritative; `Inventory` is a materialized projection.
- Negative stock is prevented by a guarded atomic update, not an `if` statement.
- Document numbers come from an atomic counter collection.
- Soft delete uses partial unique indexes; serial numbers are the exception.
- MongoDB runs as a replica set from Phase 0 so transactions actually work.
- Docker and security testing are continuous, not final phases.

### 0.6 Two defaults I set on your behalf — veto either

**Redis is out.** With financial reports gone, exports are small enough to
generate synchronously, and the remaining background work (warranty alerts, low
stock, reconciliation) is three daily jobs. The plan now uses a single worker
container running `node-cron` with a MongoDB-based advisory lock, and refresh
tokens in MongoDB with a TTL index. Strict MERN, one fewer moving part. If
concurrent users go past ~100, Redis goes back in — the job scheduler is behind an
interface so that swap is contained.

**Single company, multiple warehouses.** This is the one architectural assumption
still worth actively confirming. A tenant discriminator costs about a day now and
weeks after Phase 8. If there is any chance this serves a second legal entity, say
so before Phase 0.

### 0.7 One consequence worth naming

With values removed, this system cannot produce a GST e-way bill, an insurance
declaration, or a stock valuation for your books — all three legally require
consignment value. If any of those are eventually needed, the cleanest path is a
separate, admin-only `Valuation` collection keyed by product, rather than
reintroducing price fields across twenty schemas. The architecture below is built
so that addition stays additive.

---

## 1. SYSTEM ARCHITECTURE

### 1.1 Runtime topology

```
                    ┌──────────────────────────┐
                    │   Browser (React SPA)    │
                    │   + handheld scanners    │
                    └────────────┬─────────────┘
                                 │ HTTPS
                    ┌────────────▼─────────────┐
                    │   Nginx reverse proxy    │
                    │   static assets + /api   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │   Express API (Node)     │
                    │   stateless, N replicas  │
                    └──┬───────────────────┬───┘
                       │                   │
          ┌────────────▼──────┐   ┌────────▼─────────────┐
          │ MongoDB           │   │ File storage         │
          │ replica set rs0   │   │ volume or S3-compat  │
          │ (transactions)    │   │                      │
          └────────▲──────────┘   └──────────────────────┘
                   │
          ┌────────┴───────────────────┐
          │ Worker container           │
          │ node-cron + Mongo lock:    │
          │  · warranty alerts 02:00   │
          │  · low stock scan 06:00    │
          │  · ledger reconcile 03:00  │
          │  · integrity check weekly  │
          └────────────────────────────┘
```

The API is stateless; scaling is adding containers. The worker runs as exactly one
container, and even if it were duplicated, the Mongo advisory lock prevents
duplicate alert runs.

### 1.2 Request pipeline

```
REQUEST
  ↓
[1]  Nginx              TLS, body size limit, static/API split
  ↓
[2]  helmet + cors      security headers, origin allowlist
  ↓
[3]  rateLimit          per-IP global; tighter on auth
  ↓
[4]  requestContext     AsyncLocalStorage: requestId, actor, ip, userAgent
  ↓
[5]  authenticate       verify JWT, load user, check status + tokenVersion
  ↓
[6]  authorize          resolve effective permissions, assert route permission
  ↓
[7]  validate           Zod schema for params / query / body
  ↓
[8]  queryGuard         reject restricted fields in sort/filter/search params
  ↓
[9]  CONTROLLER         HTTP only: parse, call service, shape response
  ↓
[10] SERVICE            business rules, transactions, orchestration
  ↓
[11] REPOSITORY         Mongoose access; only layer that may select restricted fields
  ↓
[12] MODEL              schema, indexes, validators, select:false defaults
  ↓
      DATABASE
  ↓
[13] serializer         DTO mapping + permission-based field omission
  ↓
[14] auditWriter        append-only, post-commit, never blocking
  ↓
[15] errorHandler       centralized; domain errors → HTTP codes, logged with requestId
```

Layers 5–8 and 13 are mounted on the router, not called from inside handlers, so a
controller cannot skip them.

### 1.3 Authentication

- **Access token** — JWT, 15 min, HS256. Payload: `sub`, `roleId`, `permissions[]`,
  `tokenVersion`. Sent as `Authorization: Bearer`.
- **Refresh token** — 7 days, opaque 256-bit value in an `HttpOnly; Secure;
  SameSite=Strict` cookie scoped to `/api/v1/auth`. Stored SHA-256 hashed in
  MongoDB with a TTL index; the raw value never hits the database.
- **Rotation with reuse detection** — reusing a spent refresh token revokes the
  whole token family, increments `tokenVersion`, writes a `SECURITY_TOKEN_REUSE`
  audit entry and notifies Super Admin.
- **Instant revocation** — deactivating a user or changing their role or
  permissions bumps `tokenVersion`; middleware [5] compares it on every request.

Passwords: bcrypt cost 12, minimum length and breach-list check at set time.
Reset tokens are single-use, 30-minute TTL, stored hashed.

Scanner-friendly addition: warehouse devices get a longer refresh window
(configurable, default 30 days) under a `KIOSK_SESSION` flag, because a warehouse
operator re-authenticating mid-goods-receipt is how bad data gets entered.

### 1.4 Authorization

Three composable mechanisms:

1. **Permission check (route)** — `requirePermission('POST_GRN')`. Can this actor
   invoke this operation at all.
2. **Scope check (service)** — can this actor act on *this record*. `User.scope`
   carries `{ warehouseIds: [] }`; empty means all warehouses. A Warehouse Operator
   at the Hyderabad warehouse cannot post a GRN against Chennai stock.
3. **Field filter (serializer)** — the small remaining registry: vendor bank
   details, contact details.

Effective permissions = `role.permissions ∪ user.permissionGrants − user.permissionDenies`.
Denies win. `Role.rank` prevents an Admin creating a role more powerful than
themselves.

### 1.5 File storage

Multer to temp → magic-byte validation (not extension, not client MIME) → optional
ClamAV scan → UUID rename → `storage/{module}/{yyyy}/{mm}/{uuid}.{ext}`.

Never served from a public static path. `GET /documents/:id/download` resolves the
record, checks permission on the *linked* entity, then streams. Storage is behind
an adapter interface with local-disk and S3 implementations. Limits: 10 MB,
allowlist `pdf jpg jpeg png webp xlsx docx`.

### 1.6 Inventory transaction architecture

One shape for every quantity change, and exactly one code path that may write to
`Inventory`:

```
open session / transaction
  ↓
guarded atomic $inc on Inventory ──→ null? abort with InsufficientStockError
  ↓  (returns post-update doc, so quantityAfter is exact)
append InventoryTransaction { quantityBefore, quantityChange, quantityAfter, ... }
  ↓
serial state transitions (guarded, if serialized)
  ↓
domain side effects (warranty, PO tallies, transfer status)
  ↓
commit
  ↓
post-commit: audit log · notifications · cache invalidation
```

`quantityBefore` is derived as `quantityAfter − quantityChange` from the value the
database returned, never from a read taken before the update. That is what makes
the ledger self-consistent under concurrency.

`Inventory` mutation methods are private to `InventoryLedgerService`. No other
service may import them — enforced by an ESLint import rule and a test.

---

## 2. COMPLETE DATABASE DESIGN

Conventions on every collection unless noted:

- `_id: ObjectId`; `createdAt`, `updatedAt`, `createdBy`, `updatedBy`.
- `deletedAt`, `deletedBy` — soft delete. Global query middleware appends
  `{ deletedAt: null }` unless a query opts out via `.withDeleted()`.
- Uniqueness uses `partialFilterExpression: { deletedAt: null }` — except
  `SerialNumber.serialNumber`, unique across all records forever, because reusing
  one would corrupt the asset history this system exists to protect.
- **[R]** = restricted field: `select: false`, in the registry, gated on
  projection, sort, filter and export.

**No collection in this design contains a monetary field.**

### 2.1 Users

| Field | Type | Rules |
|---|---|---|
| fullName | String | required, 2–120 |
| email | String | required, unique, lowercase, indexed |
| **phone** | String **[R]** | E.164 normalized |
| passwordHash | String | required, `select: false` |
| role | ObjectId → Role | required, indexed |
| permissionGrants / permissionDenies | [String] | per-user overrides |
| scope.warehouseIds | [ObjectId] | empty = all warehouses |
| department | String | |
| status | Enum | `ACTIVE`, `INACTIVE`, `LOCKED`, `PENDING_ACTIVATION` |
| sessionProfile | Enum | `STANDARD`, `KIOSK` (long-lived warehouse session) |
| profileImage | ObjectId → Document | |
| tokenVersion | Number | bumped to revoke all sessions |
| lastLoginAt / failedLoginAttempts | | lock at 5 for 15 min |
| passwordChangedAt / mustChangePassword | | |

Indexes: `{ email: 1 }` unique-partial, `{ role: 1 }`, `{ status: 1 }`.

### 2.2 Roles

`name` (unique), `code` (unique uppercase slug), `description`,
`permissions: [String]` validated against the `PERMISSIONS` constant,
`isSystem` (undeletable), `rank` (cannot grant beyond own level), `status`.

### 2.3 Permissions

Seeded reference data: `{ code, module, label, description, isRestricted }`.
`isRestricted: true` now marks only the contact-detail and bank-detail
permissions, plus the security-administration ones.

### 2.4 Products

| Field | Type | Rules |
|---|---|---|
| name | String | required, text-indexed |
| productCode | String | required, unique |
| sku | String | required, unique, uppercase |
| category | ObjectId | required |
| subcategory / brand / manufacturer | ObjectId | optional |
| modelNumber | String | |
| description | String | |
| specifications | [{ key, value }] | free-form technical attributes |
| unitOfMeasure | Enum | `PCS BOX MTR KG SET LTR ROLL` |
| productType | Enum | `SERIALIZED`, `NON_SERIALIZED` — **immutable after first stock movement** |
| trackingAttributes | Object | `{ requiresImei, requiresMac, requiresAssetTag }` |
| serialFormatPattern | String | optional regex to validate serials at entry |
| minStockLevel / reorderLevel / reorderQuantity / maxStockLevel | Number | ≥ 0, min ≤ reorder ≤ max |
| warrantyMonths | Number | default warranty on dispatch |
| shelfLifeDays | Number | optional, for consumables |
| hsnCode | String | retained — statutory classification, not a value |
| images | [ObjectId → Document] | |
| status | Enum | `ACTIVE`, `DISCONTINUED`, `INACTIVE` |

Indexes: `{ sku: 1 }` and `{ productCode: 1 }` unique-partial,
`{ category: 1, status: 1 }`, text on `{ name, description, modelNumber }`.

`serialFormatPattern` is worth having: catching a mistyped serial at the receiving
desk is trivial; catching it after the unit has been dispatched to a customer and
a warranty claim arrives against a serial that does not exist is not.

### 2.5 Categories / Subcategories / Brands / Manufacturers

Four small collections: `{ name (unique), code, description, status }`.
Subcategory carries `category` and is unique on `{ category, name }`.
Deletion is blocked while live references exist — `409 REFERENCE_IN_USE` listing
the blockers, rather than orphaning data.

### 2.6 Vendors

`vendorName`, `vendorCode` (unique), `contactPerson`, **[R]** `phone`,
**[R]** `email`, `address`, `gstin` (15-char checksum validated), `pan`,
`leadTimeDays`, `status`, `documents[]`.

**[R]** `bankDetails { accountName, accountNumber, ifsc, bankName }` — kept
because vendor master data is genuinely useful to hold even without payment
tracking, masked to last 4 digits unless the actor holds
`VIEW_VENDOR_BANK_DETAILS`, and every full view is audit-logged. If you would
rather drop bank details entirely, say so and the field goes.

`leadTimeDays` feeds the reorder suggestion report — with no cost data, vendor
performance is measured in delivery time and short-supply rate instead.

### 2.7 Customers

`customerName`, `customerCode` (unique), `companyName`, `contactPerson`,
**[R]** `email`, **[R]** `phone`, `billingAddress`, `shippingAddresses[]`,
`gstin`, `pan`, `customerType ∈ { EXTERNAL, INTERNAL_DEPARTMENT, PROJECT_SITE }`,
`status`.

`customerType` matters for an infrastructure business: material issued to your own
project site is not a sale, but it must still leave inventory and stay traceable
to a serial. Same document flow, different classification, and the two never
contaminate each other's reports.

### 2.8 PurchaseOrders

Header: `poNumber` (unique, counter-generated), `vendor`, `orderDate`,
`expectedDeliveryDate`, `warehouse` (destination), `status`, `remarks`,
`requestedBy`, `approvedBy`, `approvedAt`, `documents[]`.

Lines (embedded, capped at 200): `product`, `orderedQuantity`,
`receivedQuantity`, `rejectedQuantity`, `shortClosedQuantity`,
`expectedDeliveryDate`, `remarks`.

`status ∈ { DRAFT, PENDING_APPROVAL, APPROVED, SENT, PARTIALLY_RECEIVED,
RECEIVED, SHORT_CLOSED, CANCELLED }` — the receiving states are **derived** from
line tallies, never set by hand.

Indexes: `{ poNumber: 1 }` unique-partial, `{ vendor: 1, orderDate: -1 }`,
`{ status: 1, expectedDeliveryDate: 1 }`.

### 2.9 GRNs (Goods Received Note)

Now carries the vendor document reference that the removed `Purchases` collection
used to hold.

`grnNumber` (unique), `vendor`, `purchaseOrder` (optional — direct receipts
allowed), `vendorInvoiceNumber`, `vendorInvoiceDate`, `vendorChallanNumber`,
`warehouse`, `receivedDate`, `receivedBy`, `vehicleNumber`, `remarks`,
`status ∈ { DRAFT, POSTED, CANCELLED }`, `documents[]`.

Unique on `{ vendor, vendorInvoiceNumber }` where present — the same vendor cannot
book the same document twice, which is the duplicate-receipt control that survives
without amounts.

Lines: `product`, `poLineId`, `orderedQuantity`, `receivedQuantity`,
`acceptedQuantity`, `damagedQuantity`, `rejectedQuantity`, `shortQuantity`,
`rackLocation`, `batchNumber`, `manufacturingDate`, `expiryDate`,
`serialNumbers[]`, `remarks`.

Invariants: `accepted + damaged + rejected = received`, and
`received ≤ ordered − alreadyReceived` unless `allowOverReceipt` is enabled with a
tolerance. Serial count must equal `acceptedQuantity` for serialized products.

A `DRAFT` GRN moves nothing. **Posting** writes inventory and is irreversible —
corrections go through a cancellation GRN writing compensating ledger entries.
There is no screen anywhere in this system that edits posted stock history.

### 2.10 Inventory (current state projection)

| Field | Type | Rules |
|---|---|---|
| product | ObjectId | required |
| warehouse | ObjectId | required |
| rackLocation | String | optional |
| availableQuantity | Number | ≥ 0, enforced by guarded update |
| reservedQuantity | Number | ≥ 0 |
| damagedQuantity | Number | ≥ 0 |
| inTransitQuantity | Number | ≥ 0 |
| underServiceQuantity | Number | ≥ 0 |
| totalQuantity | Number | derived sum |
| lastTransactionAt | Date | |
| lastReconciledAt | Date | set by the nightly job |

Unique compound `{ product: 1, warehouse: 1 }` — one row per product per
warehouse, which is what makes the guarded `$inc` atomic.
Also `{ warehouse: 1, availableQuantity: 1 }` for low-stock queries.

### 2.11 InventoryTransactions (the ledger — append-only)

| Field | Type | Rules |
|---|---|---|
| transactionNumber | String | unique, counter-generated |
| transactionType | Enum | `PURCHASE_RECEIVED, DISPATCH, CUSTOMER_RETURN, VENDOR_RETURN, DAMAGED, STOCK_ADJUSTMENT, WAREHOUSE_TRANSFER, SERVICE_OUT, SERVICE_RETURN, REPLACEMENT, RESERVATION, RESERVATION_RELEASE, SCRAP` |
| direction | Enum | `IN`, `OUT`, `NEUTRAL` |
| product | ObjectId | required, indexed |
| serialNumber | ObjectId | optional |
| warehouse | ObjectId | required |
| quantityBefore / quantityChange / quantityAfter | Number | required; signed change |
| bucketFrom / bucketTo | Enum | `AVAILABLE RESERVED DAMAGED IN_TRANSIT UNDER_SERVICE` |
| referenceType | Enum | `GRN DISPATCH_NOTE TRANSFER RETURN ADJUSTMENT SERVICE` |
| referenceId / referenceNumber | | indexed |
| reasonCode | String | mandatory on adjustments |
| performedBy | ObjectId → User | required |
| reversalOf | ObjectId | on compensating entries |
| remarks | String | |
| createdAt | Date | immutable |

**No update or delete path exists.** Mongoose `pre` hooks on
`updateOne`/`deleteOne`/`findOneAndUpdate` throw. Corrections are new rows
referencing `reversalOf`.

`bucketFrom`/`bucketTo` is an addition: without values to reconcile against,
bucket movements (available → reserved → dispatched, available → damaged) are the
only way to explain why total stock stayed the same while available stock fell.
That question comes up constantly in a warehouse and is unanswerable if the ledger
only records net quantity.

Indexes: `{ product: 1, warehouse: 1, createdAt: -1 }`,
`{ referenceType: 1, referenceId: 1 }`, `{ serialNumber: 1, createdAt: -1 }`,
`{ createdAt: -1 }`, `{ transactionType: 1, createdAt: -1 }`.

### 2.12 Warehouses

`name`, `code` (unique), `type ∈ { MAIN, BRANCH, SERVICE_CENTER, TRANSIT, SCRAP }`,
`address`, `manager → User`, `contactNumber`, `status`, and embedded
`racks: [{ code, shelves: [String] }]`.

A system-managed `TRANSIT` pseudo-warehouse holds stock that has left the source
and not yet arrived, so goods in a truck are never invisible to the system.

### 2.13 WarehouseTransfers

`transferNumber` (unique), `sourceWarehouse`, `destinationWarehouse`,
`status ∈ { DRAFT, PENDING_APPROVAL, APPROVED, IN_TRANSIT, PARTIALLY_RECEIVED,
RECEIVED, CANCELLED }`, `requestedBy/At`, `approvedBy/At`, `dispatchedBy/At`,
`receivedBy/At`, `vehicleNumber`, `remarks`, `documents[]`.

Lines: `product`, `serialNumbers[]`, `requestedQuantity`, `dispatchedQuantity`,
`receivedQuantity`, `damagedInTransitQuantity`.

Dispatch writes OUT at source + IN at transit; receipt writes OUT at transit + IN
at destination. Four ledger rows per line, and total system quantity is conserved
at every intermediate state.

### 2.14 SerialNumbers

| Field | Type | Rules |
|---|---|---|
| serialNumber | String | **unique across all records including deleted** |
| product | ObjectId | required, indexed |
| imei / macAddress / assetTag | String | sparse-unique where present |
| status | Enum | custody status — see §6 |
| warehouse | ObjectId | null once dispatched |
| rackLocation | String | |
| customer | ObjectId | set on dispatch |
| vendor / grn | ObjectId | provenance |
| dispatchNote | ObjectId | |
| batchNumber | String | |
| manufacturingDate / receivedDate / dispatchDate | Date | |
| currentWarranty | ObjectId → Warranty | |
| condition | Enum | `NEW REFURBISHED DAMAGED SCRAP` |
| installationLocation | String | optional site/rack at customer premises |

Indexes: `{ serialNumber: 1 }` unique, `{ product: 1, status: 1 }`,
`{ customer: 1 }`, `{ warehouse: 1, status: 1 }`, `{ assetTag: 1 }` sparse-unique,
`{ macAddress: 1 }` sparse-unique.

### 2.15 SerialNumberEvents (per-unit history — append-only)

`serialNumber`, `fromStatus`, `toStatus`, `eventType`, `referenceType`,
`referenceId`, `warehouse`, `customer`, `performedBy`, `remarks`, `createdAt`.

Separate from the ledger because serials change state on events that move no
stock: an RMA approved, an asset reassigned within a customer site, a warranty
voided. This is what the "full history of serial ABC123" screen reads.

### 2.16 SalesOrders

`salesOrderNumber` (unique), `customer`, `customerPoReference`, `orderDate`,
`requiredByDate`, `warehouse`, `projectReference`,
`status ∈ { DRAFT, CONFIRMED, PARTIALLY_DISPATCHED, DISPATCHED, CANCELLED, CLOSED }`,
`remarks`, `documents[]`.

Lines: `product`, `orderedQuantity`, `reservedQuantity`, `dispatchedQuantity`,
`reservedSerialNumbers[]`, `remarks`.

### 2.17 DispatchNotes

`dispatchNoteNumber` (unique), `salesOrder` (optional), `customer`,
`dispatchDate`, `warehouse`, `shippingAddress`, `vehicleNumber`, `transporter`,
`lrNumber`, `deliveredDate`, `receivedByName`,
`status ∈ { DRAFT, DISPATCHED, DELIVERED, PARTIALLY_RETURNED, RETURNED, CANCELLED }`,
`documents[]`.

Lines: `product`, `serialNumbers[]`, `quantity`, `remarks`.

Kept separate from `SalesOrder` because an order is a commitment that reserves
stock and a dispatch is the event that ships it. Merging them makes partial
dispatch and order cancellation impossible to model without lying about one of
them.

### 2.18 Warranties

`warrantyNumber`, `product`, `serialNumber`, `customer`, `dispatchNote`,
`dispatchDate`, `startDate`, `endDate` (indexed), `durationMonths`,
`provider ∈ { MANUFACTURER, VENDOR, IN_HOUSE, EXTENDED }`, `terms`,
`state ∈ { ACTIVE, VOID, CLAIMED_REPLACED, TRANSFERRED }`, `voidReason`,
`previousWarranty` (on replacement), `documents[]`.

`state` holds only what must be *stored*. Active vs expiring-soon vs expired is
computed from `endDate` at read time, so no job ever rewrites warranty rows and a
date correction fixes reporting instantly.

Indexes: `{ endDate: 1, state: 1 }` drives every alert query;
`{ serialNumber: 1, startDate: -1 }` gives per-asset warranty history across
replacements.

### 2.19 ServiceRequests

`ticketNumber` (unique), `customer`, `product`, `serialNumber`, `warranty`,
`warrantyApplicable` (**snapshotted at raise time** — warranty may expire
mid-repair and the entitlement is fixed by the raise date), `issueDescription`,
`reportedDate`, `priority ∈ { LOW MEDIUM HIGH CRITICAL }`, `slaDueDate`,
`status ∈ { OPEN, UNDER_INSPECTION, SENT_TO_VENDOR, UNDER_REPAIR, REPAIRED,
REPLACED, REJECTED, CLOSED }`, `assignedTo`, `vendor`, `vendorRmaNumber`,
`replacementSerialNumber`, `rootCause`, `resolution`, `closedAt`,
`activity[]` (embedded status-change log), `documents[]`.

### 2.20 Returns

One collection, discriminated by `returnType ∈ { CUSTOMER_RETURN, VENDOR_RETURN }`.

`returnNumber` (unique), `customer` | `vendor`, `referenceDispatchNote` |
`referenceGrn`, `returnDate`, `reason ∈ { DAMAGED, DEFECTIVE, WRONG_PRODUCT,
WARRANTY_ISSUE, REPLACEMENT, EXCESS_SUPPLY, PROJECT_SURPLUS, OTHER }`,
`status ∈ { REQUESTED, APPROVED, RECEIVED, REJECTED, COMPLETED, CANCELLED }`,
`warehouse`, `disposition ∈ { RESTOCK, REPAIR, SCRAP, RETURN_TO_VENDOR }`,
`documents[]`.

Lines: `product`, `serialNumbers[]`, `quantity`, `condition`, `remarks`.

`disposition` is a separate mandatory decision from receiving the return. That
separation is what stops defective units silently re-entering saleable stock.

`PROJECT_SURPLUS` is added for internal issues — material sent to a site and
returned unused is a common, entirely non-defective return that needs its own
reason code so it does not pollute defect-rate reporting.

### 2.21 Documents

`fileName`, `storageKey` (UUID path), `mimeType`, `sizeBytes`, `checksumSha256`,
`module`, `recordId`, `documentType`, `uploadedBy`, `isRestricted`, `deletedAt`.

`isRestricted` replaces the old `accessLevel: FINANCIAL`. It now marks vendor
agreements and anything else the Admin flags, and gates download behind
`VIEW_RESTRICTED_DOCUMENTS`. `checksumSha256` deduplicates and detects tampering.

### 2.22 AuditLogs (append-only)

`actor`, `actorRole`, `actorIp`, `userAgent`, `requestId`, `action`, `module`,
`recordId`, `recordLabel`, `changes: [{ field, before, after }]`,
`severity ∈ { INFO NOTICE WARNING CRITICAL }`, `createdAt`.

`CRITICAL` now covers: stock adjustments, GRN cancellations, permission and role
changes, user deactivation, serial status overrides, warranty voids, and settings
changes. These are the operations that can create or destroy stock, or hide that
someone did.

`changes` redacts restricted field values unless the reader holds the matching
view permission — otherwise the audit log becomes the back door around the
serializer. Retained indefinitely.

### 2.23 Notifications

`recipient` | `recipientRole`, `type`, `title`, `body`, `severity`, `module`,
`recordId`, `actionUrl`, `readAt`, `dedupeKey`, `expiresAt`.

`dedupeKey` with a unique index (e.g. `LOW_STOCK:{product}:{warehouse}:{date}`) is
what stops the low-stock job generating the same alert every run until someone
reorders.

### 2.24 Counters

`{ _id: "PO:2026-27", seq: Number }` — atomic document numbering via
`findOneAndUpdate($inc, upsert)` inside the enclosing transaction. Format
configurable per document type, scoped per financial year.

### 2.25 Settings

Key-scoped configuration: company profile, document number formats, low-stock
thresholds, warranty alert windows, over-receipt tolerance, reservation expiry
window, SLA targets, feature flags. Changes audit-logged at `CRITICAL`.

### 2.26 RefreshTokens

`userId`, `tokenHash`, `familyId`, `issuedAt`, `expiresAt` (TTL index),
`revokedAt`, `replacedBy`, `ip`, `userAgent`, `sessionProfile`.

---

## 3. ENTITY RELATIONSHIP DESIGN

```
                             ┌──────────┐
                             │ Category │──┐
                             └──────────┘  │
                             ┌──────────┐  │   ┌──────────────┐
                             │  Brand   │──┼──►│   PRODUCT    │
                             └──────────┘  │   └──┬────┬───┬──┘
                             ┌──────────┐  │      │    │   │
                             │Manufactr.│──┘      │    │   │
                             └──────────┘         │    │   │
                                                  │    │   │
  ┌────────┐   ┌────────────────┐                 │    │   │
  │ VENDOR │──►│ PURCHASE ORDER │─────────────────┘    │   │
  └───┬────┘   └───────┬────────┘                      │   │
      │                │                               │   │
      │                ▼                               │   │
      └───────────►┌───────┐                           │   │
                   │  GRN  │ (carries vendor challan/  │   │
                   └───┬───┘  invoice reference)       │   │
                       │ posting                       │   │
         ┌─────────────┼──────────────┐                │   │
         ▼             ▼              ▼                │   │
  ┌────────────┐ ┌───────────┐ ┌──────────────┐        │   │
  │ INVENTORY  │ │ INVENTORY │ │SERIAL NUMBER │◄───────┘   │
  │ (current)  │ │TRANSACTION│ │              │            │
  └─────┬──────┘ │ (ledger)  │ └──────┬───────┘            │
        │        └─────▲─────┘        │                    │
        │              │       ┌──────▼────────────┐       │
  ┌─────▼──────┐       │       │ SERIAL NUMBER     │       │
  │ WAREHOUSE  │◄──────┤       │ EVENT (history)   │       │
  └─────┬──────┘       │       └───────────────────┘       │
        │              │                                   │
        ▼              │                                   │
 ┌──────────────────┐  │                                   │
 │WAREHOUSE TRANSFER│──┤                                   │
 └──────────────────┘  │                                   │
                       │                                   │
 ┌──────────┐   ┌──────┴───────┐   ┌───────────────┐       │
 │ CUSTOMER │──►│ SALES ORDER  │──►│ DISPATCH NOTE │───────┘
 └────┬─────┘   └──────────────┘   └───┬───────┬───┘
      │                                 │       │
      │            ┌────────────────────┘       │
      │            ▼                            ▼
      │      ┌───────────┐              ┌──────────────┐
      ├─────►│ WARRANTY  │◄─────────────│    RETURN    │
      │      └─────┬─────┘              └──────┬───────┘
      │            │                           │
      │            ▼                           │
      │   ┌─────────────────┐                  │
      └──►│ SERVICE REQUEST │◄─────────────────┘
          └─────────────────┘

  Cross-cutting: DOCUMENT · AUDIT LOG · NOTIFICATION · USER · ROLE · PERMISSION
```

| Relationship | Cardinality | Enforced how |
|---|---|---|
| PO → GRN | 1 : 0..n | partial receiving; PO status derived from tallies |
| GRN → InventoryTransaction | 1 : 1..n | one per line, one transaction |
| GRN line → SerialNumber | 1 : 0..n | count must equal `acceptedQuantity` |
| Product → Inventory | 1 : 0..n | exactly one row per warehouse (unique compound) |
| Inventory ← InventoryTransaction | derived : authoritative | reconciliation job checks |
| SalesOrder → DispatchNote | 1 : 0..n | partial dispatch; order status derived |
| SerialNumber → Customer | n : 0..1 | set on dispatch, cleared on customer return |
| DispatchNote line → Warranty | 1 : 0..n | one per serialized unit |
| SerialNumber → Warranty | 1 : 0..n | multiple over time (original, replacement) |
| Warranty → ServiceRequest | 1 : 0..n | entitlement snapshotted at raise |
| ServiceRequest → SerialNumber | n : 1 | replacement adds a second serial link |

MongoDB does not enforce referential integrity, so the service layer does:
creation validates referenced ids exist and are `ACTIVE`, deletion is blocked
while live references exist, and a weekly integrity job reports orphans.

---

## 4. ROLE AND PERMISSION MATRIX

✓ full · ◐ scoped to assigned warehouses / own records · ✗ denied

| Capability | Super Admin | Admin | Inventory Mgr | Warehouse Op | Sales & Dispatch | Service Eng | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Dashboard | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ |
| Products — view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Products — create/edit | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Products — delete | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Categories / Brands | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Vendors — view | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Vendors — create/edit | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Vendor bank details | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Customers — view | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ |
| Customers — create/edit | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Contact details (phone/email) | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Purchase Orders — view | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Purchase Orders — create | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Purchase Orders — approve | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| GRN — view | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✓ |
| GRN — create | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ |
| GRN — post | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ |
| GRN — cancel | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Inventory — view | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ |
| Inventory — adjust | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ |
| Inventory — adjust above threshold | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Ledger / transactions | ✓ | ✓ | ✓ | ◐ | ✗ | ✗ | ✓ |
| Reconcile inventory | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Warehouses — manage | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Transfers — create | ✓ | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ |
| Transfers — approve | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Transfers — dispatch/receive | ✓ | ✓ | ◐ | ◐ | ✗ | ✗ | ✗ |
| Serials — view/scan | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Serials — manage/override status | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Sales Orders — view | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Sales Orders — create/confirm | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Dispatch Notes — create | ✓ | ✓ | ✗ | ◐ | ✓ | ✗ | ✗ |
| Dispatch Notes — cancel | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Warranty — view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Warranty — void/extend | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Service Requests — view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Service Requests — create | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ |
| Service Requests — assign | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| Service Requests — work/close | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Returns — create | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✗ |
| Returns — approve/disposition | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Documents — general | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Documents — restricted | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Reports | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ |
| Export data | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| Users & Roles | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Manage Admin / Super Admin | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Audit Logs | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Settings | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ | ✗ |

Two deliberate asymmetries:

**Warehouse Operator can post a GRN but cannot cancel one.** Receiving is their
job; reversing posted stock history is not, because that is the operation an
operator would reach for to cover a counting mistake.

**Inventory Manager can adjust stock, but only below a value-free quantity
threshold** (configurable per product, default: 5% of on-hand or 10 units,
whichever is greater). Larger adjustments need Admin. With no monetary values to
threshold on, quantity relative to holding is the available proxy, and it is the
right one — a 200-unit adjustment on a 10,000-unit cable reel is routine, the same
adjustment on servers is not.

Admin's Settings access excludes document number formats already in use, audit
retention, and permission definitions — those are Super Admin only, because they
are the settings that could be used to cover tracks.

### 4.1 Permission catalogue

`VIEW_ / CREATE_ / UPDATE_ / DELETE_` per module: `PRODUCT CATEGORY VENDOR
CUSTOMER PURCHASE_ORDER GRN INVENTORY WAREHOUSE TRANSFER SERIAL SALES_ORDER
DISPATCH_NOTE WARRANTY SERVICE_REQUEST RETURN DOCUMENT USER ROLE SETTING`.

Action permissions: `APPROVE_PURCHASE_ORDER, POST_GRN, CANCEL_GRN,
ADJUST_INVENTORY, ADJUST_INVENTORY_UNLIMITED, RECONCILE_INVENTORY,
APPROVE_TRANSFER, DISPATCH_TRANSFER, RECEIVE_TRANSFER, OVERRIDE_SERIAL_STATUS,
CONFIRM_SALES_ORDER, CREATE_DISPATCH, CANCEL_DISPATCH, VOID_WARRANTY,
ASSIGN_SERVICE_REQUEST, WORK_SERVICE_REQUEST, APPROVE_RETURN, SET_DISPOSITION,
EXPORT_DATA, VIEW_AUDIT_LOGS, MANAGE_SUPER_ADMIN`.

Restricted-field permissions: `VIEW_CONTACT_DETAILS, VIEW_VENDOR_BANK_DETAILS,
VIEW_RESTRICTED_DOCUMENTS`.

---

## 5. ACCESS CONTROL ARCHITECTURE

Five layers now instead of eight. What each one stops:

**Layer 1 — Schema default-deny.** Every **[R]** field is `select: false`. A
developer who writes a new endpoint and forgets this document ships an endpoint
that returns less, not more. *Stops the accidental leak.*

**Layer 2 — Central registry.** One file maps model → field → required
permission, consumed by the repository, serializer, query guard and export
builder. A CI test diffs schema paths against the registry so a new restricted
field cannot be added without registering it. *Stops drift.*

**Layer 3 — Repository-gated selection.** Only
`BaseRepository.selectRestricted(model, permissions)` may add `+field`
projections, and it takes the permission set as a required argument. An ESLint
rule forbids `.select('+` anywhere else. *Stops the well-meaning fix.*

**Layer 4 — Query guard.** Sort, filter, search and groupBy keys are resolved
against the registry and rejected with `403 RESTRICTED_FIELD_ACCESS_DENIED` plus
an audit entry — not silently dropped, because a silent drop makes a probe look
like a legitimate empty result. *Stops inference.*

**Layer 5 — Serializer.** Responses are built by explicit DTO mappers, never by
returning Mongoose documents. Unauthorized keys are **omitted**, not nulled or
masked, because `phone: null` on a list still reveals which records have one.
*Stops the residual leak and metadata leakage about the filtering itself.*

Frontend `<PermissionGuard>` sits outside this list on purpose. It is UX, not
security, and says so in its own source comment so nobody mistakes it for
protection.

### 5.1 Scope enforcement

Warehouse scoping is the access control that actually earns its keep in this
version. Every service that touches stock resolves the actor's
`scope.warehouseIds` and applies it as a mandatory query condition — not as a
filter the caller can override. A Warehouse Operator requesting a GRN from another
site gets `404`, not `403`: existence is not disclosed.

---

## 6. SERIAL NUMBER LIFECYCLE

### 6.1 Custody status transition table

| From | Allowed to | Trigger |
|---|---|---|
| *(none)* | `RECEIVED` | GRN posting |
| `RECEIVED` | `AVAILABLE`, `DAMAGED`, `RETURNED_TO_VENDOR` | QC outcome |
| `AVAILABLE` | `RESERVED`, `IN_TRANSIT`, `DAMAGED`, `SCRAPPED`, `RETURNED_TO_VENDOR` | order / transfer / adjustment |
| `RESERVED` | `DISPATCHED`, `AVAILABLE` | dispatch / reservation released |
| `IN_TRANSIT` | `AVAILABLE`, `DAMAGED` | transfer received |
| `DISPATCHED` | `UNDER_SERVICE`, `RETURNED_BY_CUSTOMER` | service raised / customer return |
| `UNDER_SERVICE` | `DISPATCHED`, `REPLACED`, `SCRAPPED` | repaired / replaced |
| `REPLACED` | `RETURNED_TO_VENDOR`, `SCRAPPED` | terminal for the replaced unit |
| `RETURNED_BY_CUSTOMER` | `AVAILABLE`, `DAMAGED`, `SCRAPPED`, `RETURNED_TO_VENDOR` | disposition decision |
| `DAMAGED` | `AVAILABLE`, `SCRAPPED`, `RETURNED_TO_VENDOR` | repair / write-off |
| `SCRAPPED` | — | terminal |
| `RETURNED_TO_VENDOR` | — | terminal |

Anything not in this table is rejected with `422 INVALID_STATE_TRANSITION`. The
table is one constant, exhaustively unit-tested: every state pair is asserted
allowed or denied, so a future edit cannot quietly widen it.

`AVAILABLE → DISPATCHED` is deliberately absent. A dispatch must pass through
`RESERVED`, and that reservation is the atomic claim that makes "a serial can
never be dispatched twice" a database guarantee rather than an application
promise.

`OVERRIDE_SERIAL_STATUS` exists for genuine data corrections, requires a reason
code, and writes a `CRITICAL` audit entry. It is held by Inventory Manager and
above only.

### 6.2 Warranty as an independent dimension

```
custody:  RECEIVED → AVAILABLE → RESERVED → DISPATCHED ──────────────►
                                                │
warranty:                                       └─► Warranty created
                                                    endDate = dispatch + N months
                                                    computed at read time:
                                                      now < end − 30d → ACTIVE
                                                      now < end       → EXPIRING_SOON
                                                      now ≥ end       → EXPIRED
                                                      state = VOID    → VOID
                                                      open claim      → UNDER_CLAIM
```

A unit under repair is `UNDER_SERVICE` *and* independently in or out of warranty.
Neither dimension needs to know about the other, and no job rewrites serial rows.

---

## 7. CORE WORKFLOWS

### 7.1 Purchase to stock

```
  PURCHASE ORDER  DRAFT → PENDING_APPROVAL → APPROVED → SENT
        ↓
  MATERIAL ARRIVES
        ↓
  GRN (DRAFT) — quantities, condition, batch, serials captured at the dock
        ↓
  ╔══════════ GRN POSTING — ONE TRANSACTION ═══════════════════════╗
  ║  1. idempotency: reject if already posted                       ║
  ║  2. validate products ACTIVE, type matches, warehouse in scope   ║
  ║  3. validate received ≤ ordered − alreadyReceived (± tolerance)  ║
  ║  4. validate serial count === acceptedQuantity                   ║
  ║  5. validate serial format pattern; reject any already existing  ║
  ║  6. per line:                                                    ║
  ║       a. upsert Inventory, guarded $inc available += accepted     ║
  ║       b. $inc damagedQuantity += damaged                          ║
  ║       c. append InventoryTransaction PURCHASE_RECEIVED            ║
  ║       d. create SerialNumbers → RECEIVED → AVAILABLE              ║
  ║       e. append SerialNumberEvent per unit                        ║
  ║  7. update PO line tallies, derive PO status                     ║
  ║  8. GRN status = POSTED                                          ║
  ╚═════════════════════════════════════════════════════════════════╝
        ↓ commit → audit · notifications · label print queue
  AVAILABLE INVENTORY
```

**Partial receiving.** Ordered 100, GRN-1 receives 80 → PO `PARTIALLY_RECEIVED`,
pending 20. GRN-2 receives 20 → `RECEIVED`. Inventory rises by 80 then 20, never
by 100. A PO can be `SHORT_CLOSED` with a reason if the vendor cannot supply the
balance — recorded honestly rather than pretending goods arrived.

**Damaged and short.** Damaged units land in `damagedQuantity` — visible,
countable, reportable, and unsaleable. Their exit is a vendor return or a scrap
adjustment, each writing its own ledger row. Shortages increase nothing; they are
recorded as a claim against the vendor and surface in the pending-PO report.

**Adjustments** require a reason code (`PHYSICAL_COUNT, DAMAGE, THEFT, EXPIRY,
DATA_CORRECTION, FOUND_STOCK`), free-text remarks, and a second approver above
threshold. This is the one operation that can create stock from nothing, so it
carries the tightest control in the system.

### 7.2 Dispatch

```
  SALES ORDER (DRAFT) → CONFIRM
        ↓ ══ TRANSACTION ═════════════════════════════════╗
          guarded $inc: available −q, reserved +q          ║
          claim serials AVAILABLE → RESERVED (atomic each) ║
          ledger: RESERVATION rows, direction NEUTRAL      ║
        ══════════════════════════════════════════════════╝
        ↓
  DISPATCH NOTE
        ↓ ══ TRANSACTION ═════════════════════════════════╗
          1. re-validate reservation still held by order   ║
          2. guarded $inc: reserved −q                     ║
          3. ledger: DISPATCH rows, direction OUT          ║
          4. serials RESERVED → DISPATCHED, customer set   ║
          5. SerialNumberEvent per unit                    ║
          6. Warranty created per serialized unit          ║
          7. dispatch note number from FY counter          ║
          8. SO line dispatchedQuantity, derive SO status  ║
        ══════════════════════════════════════════════════╝
        ↓ commit → audit · warranty certificate · delivery challan PDF
  CUSTOMER HOLDS ASSET · WARRANTY ACTIVE
```

Reservations that go stale past the configured window (default 7 days) are
**flagged, not auto-released**. Silently un-reserving stock a salesperson is
negotiating around causes worse problems than a stale reservation; the release is
a human action.

Idempotency: dispatch accepts an `Idempotency-Key` header, so a retried request
returns the original dispatch note rather than shipping twice.

Prevented by construction: negative stock (guarded `$inc`), duplicate serial
dispatch (atomic claim + unique index), dispatching unavailable stock
(reservation precondition), dispatching another warehouse's stock (warehouse is
part of the Inventory unique key).

### 7.3 Transfers

Dispatch writes OUT at source + IN at `TRANSIT`; receipt writes OUT at `TRANSIT` +
IN at destination. Four ledger rows per line. Total system quantity is conserved
at every intermediate state, so a truck in motion never makes stock disappear from
the global count.

### 7.4 Warranty and service

```
  DISPATCH NOTE → WARRANTY  start = dispatchDate, end = start + warrantyMonths
        ↓
  ┌──── daily job 02:00 ──────────────────────────────────────┐
  │ Warranty { endDate ∈ [today, today+30], state: ACTIVE }    │
  │ notify at 30 / 15 / 7 / 0 days, deduped, permission-filtered│
  └────────────────────────────────────────────────────────────┘
        ↓
  SERVICE REQUEST RAISED
    · entitlement snapshotted at raise date (immutable thereafter)
    · serial DISPATCHED → UNDER_SERVICE, ledger SERVICE_OUT
        ↓
  ┌──────────┬───────────────┬──────────────┬────────────┐
  ▼          ▼               ▼              ▼            ▼
REPAIRED  SENT_TO_VENDOR  REPLACED      REJECTED      CLOSED
  │          │ vendor RMA    │ new serial issued
  │          │ tracked       │ old unit → REPLACED
  ▼          ▼               ▼
serial UNDER_SERVICE → DISPATCHED, ledger SERVICE_RETURN
```

On replacement: the customer's warranty follows the **replacement** serial with
the *original* end date (a swap does not restart the clock unless Settings says
otherwise), the old unit becomes `REPLACED` and leaves saleable stock, and both
serials are linked so asset history reads continuously across the swap.

### 7.5 Returns

```
CUSTOMER RETURN                        VENDOR RETURN
 requested (reason)                     raised from damaged/rejected stock
     ↓ approve                              ↓ approve
 goods received at warehouse            debit note / RMA reference
     ↓                                      ↓
 DISPOSITION (mandatory, separate)      goods dispatched to vendor
  ├─ RESTOCK → serial AVAILABLE             ↓
  │            ledger CUSTOMER_RETURN IN  ledger VENDOR_RETURN OUT
  ├─ REPAIR  → serial UNDER_SERVICE       serial RETURNED_TO_VENDOR
  ├─ SCRAP   → serial SCRAPPED                ↓
  └─ RTV     → serial RETURNED_TO_VENDOR  replacement arrives → new GRN
     ↓
 warranty retained / voided / transferred
     ↓
 audit log
```

Every branch writes an `InventoryTransaction`, a `SerialNumberEvent` where
applicable, and an audit entry.

---

## 8. API ARCHITECTURE

Base `/api/v1`. Envelope:

```json
{ "success": true,  "message": "...", "data": {}, "meta": { "page": 1, "total": 0 } }
{ "success": false, "message": "...", "errors": [{ "code": "...", "field": "..." }] }
```

### 8.1 Conventions

- `401` unauthenticated · `403` unauthorized or restricted-field denial ·
  `404` not found **or out of warehouse scope** (existence never disclosed) ·
  `409` conflict / duplicate / reference-in-use · `422` domain rule violation ·
  `429` rate limited.
- Stable machine codes: `INSUFFICIENT_STOCK`, `SERIAL_ALREADY_DISPATCHED`,
  `INVALID_STATE_TRANSITION`, `DUPLICATE_SERIAL`, `SERIAL_FORMAT_INVALID`,
  `GRN_ALREADY_POSTED`, `OVER_RECEIPT_EXCEEDED`, `RESTRICTED_FIELD_ACCESS_DENIED`,
  `REFERENCE_IN_USE`, `WAREHOUSE_OUT_OF_SCOPE`.
- `Idempotency-Key` on: GRN post, dispatch create, transfer dispatch/receive,
  return receive.
- List endpoints: `?page&limit&sort&search&filter[...]&fields`.
- Rate limits: 5/min login and password reset, 300/min general.

### 8.2 Endpoint map

**Auth** — `POST /auth/login · /refresh · /logout · /logout-all ·
/forgot-password · /reset-password · /change-password`;
`GET /auth/me` → user, role, **effective permissions**, warehouse scope. This is
the frontend's single source of truth for guards; permissions are never decoded
from the JWT client-side.

**Users** `[MANAGE_USER]` — `GET|POST /users`, `GET|PUT|DELETE /users/:id`,
`PATCH /users/:id/status · /permissions · /scope`,
`POST /users/:id/reset-password`, `GET /users/:id/activity`.

**Roles** `[MANAGE_ROLE]` — `GET|POST /roles`, `PUT|DELETE /roles/:id`,
`GET /permissions`, `GET /roles/:id/effective-preview`.

**Products** — `GET|POST /products`, `GET|PUT|DELETE /products/:id`,
`GET /products/:id/stock` (across warehouses),
`GET /products/:id/movement` (ledger, filtered),
`POST /products/import` (CSV, dry-run first).

**Masters** — `/categories · /subcategories · /brands · /manufacturers ·
/vendors · /customers` CRUD, plus `GET /vendors/:id/purchase-history`,
`GET /vendors/:id/performance` (lead time, short-supply rate, defect rate),
`GET /customers/:id/assets`, `GET /customers/:id/warranties`,
`GET /customers/:id/service-history`.

**Purchase Orders** — `GET|POST /purchase-orders`,
`GET|PUT /purchase-orders/:id`, `POST /purchase-orders/:id/approve · /cancel ·
/close-short`, `GET /purchase-orders/pending-receipt`.

**GRN** — `GET|POST /grn`, `GET|PUT /grn/:id`,
`POST /grn/:id/post` `[POST_GRN]`, `POST /grn/:id/cancel` `[CANCEL_GRN]`.

**Inventory** — `GET /inventory`, `GET /inventory/:id`,
`POST /inventory/adjust` `[ADJUST_INVENTORY]`,
`GET /inventory/transactions`, `GET /inventory/low-stock`,
`GET /inventory/reorder-suggestions`,
`POST /inventory/reconcile` `[RECONCILE_INVENTORY]`,
`POST /inventory/stock-count` (physical count session → adjustment batch).

**Warehouses / Transfers** — `/warehouses` CRUD,
`GET /warehouses/:id/inventory`, `GET|POST /transfers`,
`POST /transfers/:id/approve · /dispatch · /receive · /cancel`.

**Serials** — `GET /serials`, `GET /serials/:serialNumber` *(the scan endpoint —
one round trip, returns product, status, location, customer, warranty, open
tickets)*, `GET /serials/:id/history`,
`PATCH /serials/:id/status` `[OVERRIDE_SERIAL_STATUS]`,
`GET /serials/:id/qrcode`, `GET /serials/:id/label`,
`POST /serials/bulk-import` (dry-run then commit).

**Sales & Dispatch** — `GET|POST /sales-orders`,
`POST /sales-orders/:id/confirm · /cancel · /release-reservation`;
`GET|POST /dispatch-notes`, `POST /dispatch-notes/:id/cancel · /mark-delivered`,
`GET /dispatch-notes/:id/challan` (PDF).

**Warranty** — `GET /warranties`, `GET /warranties/:id`,
`GET /warranties/expiring?days=30`, `GET /warranties/expired`,
`POST /warranties/:id/void` `[VOID_WARRANTY]`,
`GET /warranties/:id/certificate`.

**Service** — `GET|POST /service-requests`, `PUT /service-requests/:id`,
`POST /service-requests/:id/assign · /status · /close`,
`GET /service-requests/sla-breaches`.

**Returns** — `GET|POST /returns`,
`POST /returns/:id/approve · /receive · /disposition`.

**Documents** — `POST /documents` (multipart), `GET /documents/:id/download`,
`DELETE /documents/:id`.

**Reports** — `GET /reports/stock · /stock-movement · /low-stock ·
/warehouse-inventory · /damaged · /adjustments · /purchase · /dispatch ·
/warranty · /serials · /service · /ageing`;
`POST /reports/:type/export` `[EXPORT_DATA]` → CSV / Excel / PDF.

**Dashboard** — `GET /dashboard/summary`, `GET /dashboard/charts/:key`.

**Audit / Notifications / Settings** — `GET /audit-logs` `[VIEW_AUDIT_LOGS]`;
`GET /notifications`, `PATCH /notifications/:id/read`,
`POST /notifications/read-all`; `GET|PUT /settings/:key`.

Two endpoints worth calling out. `GET /serials/:serialNumber` is the single most
used call in the system once it is live — a scan at the dock, at the pick face, at
a customer site — so it is one round trip returning everything a person needs, and
it is cached per serial with tag-based invalidation. `POST /inventory/stock-count`
exists because physical counts are how inventory systems actually stay accurate,
and doing them as a hundred individual adjustments produces a hundred audit
entries and no coherent record of the count itself.

---

## 9. FRONTEND ARCHITECTURE

### 9.1 State

- **Server state** — RTK Query. Cache tags per entity: posting a GRN invalidates
  `Inventory`, `SerialNumber`, `PurchaseOrder`, `InventoryTransaction` in one
  declaration.
- **Session** — `authSlice`: user, effective permissions, warehouse scope, token
  lifecycle. Populated from `GET /auth/me`.
- **UI** — local state; table filters live in the URL query string so a filtered
  view is shareable and survives a refresh.

### 9.2 Permission guarding

```jsx
<PermissionGuard permission="ADJUST_INVENTORY">   // hides subtree
usePermission('POST_GRN')                          // boolean hook
useWarehouseScope()                                // scoped selectors
<ProtectedRoute permission="VIEW_AUDIT_LOGS">
columns.filter(c => !c.permission || can(c.permission))
```

Navigation, table columns, dashboard widgets, form fields, filter options and bulk
actions all derive from the same permission list, so the sidebar cannot drift out
of sync with the routes.

### 9.3 Component inventory

`DataTable` (server-side sort/filter/paginate, permission-aware columns, column
visibility, export), `FilterPanel`, `DateRangePicker`, `EntitySelect` (async
combobox), `SerialNumberPicker` (scan or select, live availability check),
`ScanInput` (keyboard-wedge scanner support: rapid input + Enter),
`QuantityInput` (integer-only, bucket-aware), `StatusBadge`, `FileUploader`,
`ConfirmDialog` (reason-code capture for destructive actions), `Timeline`
(serial and service history), `AuditTrailPanel`, `LabelPreview`, `PrintLayout`,
`PermissionGuard`, `EmptyState`, `ErrorState`, `LoadingSkeleton`.

### 9.4 UX decisions

- **Desktop-first**, but the four warehouse screens — GRN entry, pick/pack, stock
  check, serial scan — get a real mobile layout with large touch targets, because
  that is where a phone or handheld is actually in someone's hand.
- **Global scan bar** on every page: scan a serial anywhere, land on its detail.
- **Optimistic updates are disabled** on anything that moves stock. A dispatch
  that appears to succeed and then fails is worse than a half-second spinner.
- **Reason codes are modal-blocking** on adjustments, cancellations and status
  overrides. The friction is the point.
- Dark mode via CSS variables, persisted per user.

### 9.5 Pages

Dashboard · Login / Forgot Password · Products · Product Detail · Categories ·
Brands · Vendors · Vendor Detail · Customers · Customer Detail · Purchase Orders ·
PO Detail · GRN · GRN Entry · Inventory · Inventory Transactions · Stock Count ·
Warehouses · Warehouse Detail · Transfers · Transfer Detail · Serial Numbers ·
Serial Detail · Sales Orders · SO Detail · Dispatch Notes · Dispatch Detail ·
Warranty · Warranty Detail · Service Requests · Service Detail · Returns ·
Return Detail · Reports · Users · Roles · Audit Logs · Notifications · Settings

---

## 10. FOLDER STRUCTURE

```
inventory-management/
├── backend/
│   ├── src/
│   │   ├── config/          db.js, env.js, logger.js, swagger.js
│   │   ├── constants/       permissions.js, restrictedFields.js, enums.js,
│   │   │                    serialTransitions.js, transactionTypes.js,
│   │   │                    reasonCodes.js
│   │   ├── models/          one file per collection (§2)
│   │   ├── repositories/    baseRepository.js + per-entity; ONLY place
│   │   │                    permitted to select restricted fields
│   │   ├── services/
│   │   │   ├── inventory/   ledgerService.js (sole writer of Inventory),
│   │   │   │                adjustmentService.js, reconciliationService.js,
│   │   │   │                stockCountService.js
│   │   │   ├── purchase/    poService.js, grnService.js
│   │   │   ├── dispatch/    salesOrderService.js, dispatchService.js
│   │   │   ├── serial/      serialService.js, transitionValidator.js,
│   │   │   │                labelService.js
│   │   │   ├── warranty/    warrantyService.js, serviceRequestService.js
│   │   │   ├── transfer/    transferService.js
│   │   │   ├── returns/     returnService.js
│   │   │   ├── report/      metricRegistry.js, reportService.js, exportService.js
│   │   │   └── shared/      counterService.js, auditService.js,
│   │   │                    notificationService.js, storageService.js,
│   │   │                    scopeService.js
│   │   ├── controllers/     thin HTTP adapters
│   │   ├── routes/v1/       index.js + per-module routers
│   │   ├── middleware/      authenticate, authorize, validate, queryGuard,
│   │   │                    requestContext, rateLimit, idempotency, upload,
│   │   │                    errorHandler
│   │   ├── serializers/     DTO mappers + permission projection
│   │   ├── validators/      Zod schemas per module
│   │   ├── jobs/            warrantyAlerts, lowStock, reconciliation,
│   │   │                    integrityCheck, scheduler.js, mongoLock.js
│   │   ├── utils/           errors.js, pagination.js, qrcode.js, barcode.js,
│   │   │                    dates.js, csv.js
│   │   ├── db/              seeds/, migrations/, indexes.js
│   │   ├── docs/            openapi.yaml, adr/
│   │   ├── app.js
│   │   └── server.js
│   ├── worker.js            cron entrypoint (same image, different command)
│   ├── tests/               unit/ integration/ security/ concurrency/ fixtures/
│   ├── storage/             uploads (gitignored, volume-mounted)
│   ├── Dockerfile
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── app/             store.js, apiSlice.js, routes.jsx
│   │   ├── components/      ui/ · common/ · table/ · form/ · feedback/ · scan/
│   │   ├── layouts/         AppLayout, AuthLayout, PrintLayout, MobileLayout
│   │   ├── features/        one folder per module: api slice, pages,
│   │   │                    components, hooks, schemas, columns
│   │   ├── hooks/           usePermission, useWarehouseScope, useScanner,
│   │   │                    useDebounce, useQueryParams, useConfirm
│   │   ├── lib/             axios.js, format.js, permissions.js
│   │   ├── constants/       navigation.js (permission-tagged), enums.js
│   │   └── main.jsx
│   ├── Dockerfile
│   └── .env.example
│
├── docker/                  mongo-init-rs.js, nginx.conf, mongo.conf
├── docs/                    ARCHITECTURE.md, API.md, SETUP.md, DEPLOYMENT.md,
│                            SECURITY.md, PERMISSIONS.md, OPERATIONS.md
├── docker-compose.yml
├── docker-compose.prod.yml
└── README.md
```

---

## 11. DEVELOPMENT ROADMAP

Thirteen phases instead of eighteen — the financial phases are gone and security
testing is folded into every phase rather than deferred.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0** | Repo, Docker, **Mongo replica set**, CI, lint, logging, error handler, health check | `rs.status()` healthy; a test transaction commits and rolls back correctly |
| **1** | Auth, users, roles, permissions, RBAC + scope middleware, restricted-field registry, query guard, serializer, audit infrastructure, login UI | Permission matrix suite green for all 7 roles; token rotation and reuse detection proven |
| **2** | Products, categories, brands, manufacturers, vendors, customers, warehouses; CRUD, search, pagination, CSV import | Reference-in-use deletion blocking works; contact-detail restriction proven |
| **3** | Purchase orders, GRN, partial receiving, document upload — **first ledger writes** | GRN posting atomic: forced mid-transaction failure leaves zero partial state |
| **4** | Inventory, ledger UI, adjustments with reason codes, stock count, reconciliation job | 50 parallel requests for 10 units → exactly 10 succeed, ledger sums to inventory |
| **5** | Warehouse transfers, approval, transit, receipt | Total system quantity conserved at every transfer state |
| **6** | Serial numbers, state machine, asset tags, QR/barcode, labels, history, bulk import | Every state pair asserted; duplicate serial rejected at both DB and service level |
| **7** | Sales orders, reservation, dispatch notes, customer assignment, challan PDF | Serial cannot be dispatched twice under concurrency; idempotent dispatch |
| **8** | Warranty creation and derivation, alerts, service requests, repair, replacement | Warranty dates correct across month ends, year boundaries and leap days |
| **9** | Customer and vendor returns, disposition, replacement flow | Every return path writes ledger + serial event + audit |
| **10** | Documents, dashboard, charts | Non-scoped user's dashboard contains no other warehouse's data |
| **11** | Reports, exports, notifications with dedupe | No duplicate alerts across a 7-day simulated run |
| **12** | Audit UI, load and penetration testing, Swagger, deployment, backup rehearsal | Restore-from-backup rehearsed successfully; §18 checklist signed off |

Each phase ends: tests green → demo → your review → next phase. No phase begins
before the previous is signed off.

### 11.1 Testing per phase

- **Unit** — services against an in-memory replica set; pure functions (warranty
  dates, transitions, quantity arithmetic) tested exhaustively.
- **Integration** — full pipeline against containerized Mongo, including
  transaction rollback under injected failure.
- **Security** — parameterized role × endpoint × field matrix, run in CI on every
  commit. Adding a route without a registered permission fails this suite. This is
  the one that never gets skipped to ship a phase.
- **Concurrency** — parallel-request tests on every stock-moving operation.

---

## 12. SEED DATA

Seven users, one per role, `mustChangePassword: true`, credentials documented in
`docs/SETUP.md` — never in the repo, never reused between environments. The seed
refuses to run when `NODE_ENV === 'production'` unless explicitly forced.

Demo dataset: 3 warehouses with rack layouts, 8 categories, 12 brands, ~60
products (mixed serialized and non-serialized — IT hardware and fibre optic
consumables), 10 vendors, 15 customers including one internal project site, 20 POs
across every status, 25 GRNs including partial and damaged receipts, ~400 serials
spread across every lifecycle state, 30 dispatch notes, warranties at varied
distances from expiry (some inside 7 days so the alert job has work on day one),
8 service requests including one replacement, 5 returns across all four
dispositions, one in-transit transfer, one short-closed PO.

The demo data is deliberately messy, because clean seed data hides exactly the
bugs this system needs not to have.

---

## 13. REMAINING OPEN ITEMS

Everything else is settled. These three still want a word from you, and only the
first is expensive to defer:

1. **Single company, or will this ever serve a second legal entity?** A tenant
   discriminator costs about a day now and weeks after Phase 8. I have assumed
   single company, multiple warehouses.
2. **Vendor bank details** — keep the field (masked, permission-gated,
   audit-logged) or drop it entirely now that there is no payment tracking?
3. **Barcode symbology and label size** — Code128 on 50×25mm assumed. Confirm
   against the printer you actually have, since label layout is easier to get
   right in Phase 6 than to redo afterwards.

### Risks

| Risk | Mitigation |
|---|---|
| Ledger and Inventory drift under load | nightly reconciliation + drift alert; never silent self-heal |
| Ledger growth degrades reports | compound indexes now; monthly pre-aggregated snapshots at Phase 11 if needed |
| Serial bulk import creating duplicates | staged dry-run validation report before commit |
| Warehouse staff bypassing scans under time pressure | scan-first UI flows, and GRN posting requires the serial count to match |
| Permission model confusing operators | Roles screen shows an effective-permission preview per user |
| Scope creep during phases | phase exit criteria fixed at sign-off; new requests become Phase 13+ |

---

## APPENDIX A — Business rules traceability

| # | Rule | Enforced by |
|---|---|---|
| 1 | Inventory cannot go below zero | guarded `$inc` with `$gte` precondition |
| 2 | Every movement creates a transaction | `Inventory` writes private to `InventoryLedgerService` |
| 3 | Serial numbers unique | unique index across all records incl. deleted |
| 4 | A serial cannot be dispatched twice | atomic `AVAILABLE→RESERVED` claim + transition table |
| 5 | Dispatched serials linked to a customer | dispatch transaction sets customer; asserted post-commit |
| 6 | Warranty starts on dispatch | created inside the dispatch transaction |
| 7 | Expiry calculated automatically | derived from `startDate + durationMonths` at read time |
| 8 | Only authorized users modify inventory | `ADJUST_INVENTORY` + warehouse scope + threshold |
| 9 | Unauthorized users never receive restricted fields | layers 1, 3, 5 |
| 10 | Exports respect permissions | shared metric whitelist with reports |
| 11 | Soft delete on important records | global query middleware + partial unique indexes |
| 12 | Inventory history never deleted | no delete path exists on the ledger |
| 13 | Every modification audit-logged | post-commit hook in the service base |
| 14 | Transactions on critical operations | replica set from Phase 0; session threaded through services |
| 15 | Transfers maintain accuracy | four-row transit model conserves total quantity |
| 16 | Partial GRN supported | per-line receipt tallies; PO status derived |
| 17 | QR codes expose nothing sensitive | payload is `{ serialNumber }` only; details fetched via authenticated API |
| 18 | Search respects permissions and scope | query guard + mandatory scope condition |
| 19 | Direct API access cannot bypass | all enforcement server-side |
| 20 | Frontend hiding is not security | documented as UX-only in the guard component |

---

## STOP — ARCHITECTURE REVIEW GATE

Implementation does not begin here.

**What I need from you:** the three items in §13, and confirmation that removing
the `Purchases` collection, renaming `SalesInvoice` to `DispatchNote`, and
replacing `Accounts Team` with `Warehouse Operator` and `Service Engineer` are all
what you intended.

On approval, Phase 0 delivers the repository skeleton, Docker Compose with a
working MongoDB replica set, CI, and a proven transaction round-trip. Phase 1
follows with authentication plus the full RBAC, scope and field-restriction
spine — the phase every later phase depends on being right.

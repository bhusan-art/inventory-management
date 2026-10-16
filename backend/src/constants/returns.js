/**
 * Returns — the two directions, and what may happen to the goods.
 *
 * A return is the only flow in the system where stock arrives whose CONDITION
 * IS UNKNOWN. Everything else enters through a GRN, where someone at the dock
 * inspected it and said how much was good. A customer return arrives in a box
 * with a complaint attached.
 *
 * That is why returned goods land in the DAMAGED bucket and not AVAILABLE (see
 * STATUS_BUCKET in inventory.js). DAMAGED here means "not sellable yet", which
 * is the honest default: countable, visible, and unavailable until a human
 * looks at it. Restocking on arrival would mean a faulty unit could be
 * dispatched to the next customer before anyone opened the box.
 */

/** Why a customer sent it back. */
export const CUSTOMER_RETURN_REASONS = Object.freeze([
  'DEFECTIVE',
  'WRONG_ITEM_SHIPPED',
  'NOT_AS_DESCRIBED',
  'DAMAGED_IN_TRANSIT',
  'ORDER_CANCELLED',
  'EXCESS_DELIVERY',
  'END_OF_LIFE_RETURN',
]);

/** Why we are sending it back to a vendor. */
export const VENDOR_RETURN_REASONS = Object.freeze([
  'DEFECTIVE_ON_ARRIVAL',
  'WRONG_ITEM_RECEIVED',
  'EXCESS_RECEIVED',
  'FAILED_IN_WARRANTY',
  'RECALL',
]);

/**
 * What happens to a returned unit. The decision a human makes after inspecting
 * it, which is why it is stored rather than derived.
 *
 * Each disposition is a specific ledger movement out of the DAMAGED bucket:
 *
 *   RESTOCK          DAMAGED → AVAILABLE   (inspected, sellable again)
 *   QUARANTINE       stays in DAMAGED      (held, decision deferred)
 *   SCRAP            DAMAGED → out         (written off, leaves stock)
 *   RETURN_TO_VENDOR stays in DAMAGED      (earmarked; the RTV moves it)
 *
 * QUARANTINE is a real choice, not an absence of one: it records that somebody
 * looked and decided to hold the unit. "No disposition yet" is the absence, and
 * it is a different state.
 *
 * RETURN_TO_VENDOR deliberately moves NOTHING. The goods are still on our
 * premises until the vendor return is approved and sent, so the stock stays in
 * quarantine and the serial stays DAMAGED. Taking the unit out of stock here
 * would leave the quantity in the DAMAGED bucket while the serial said it had
 * left — the exact drift the nightly reconciliation exists to report, caused by
 * us. One physical movement, one ledger movement, and it happens in
 * `sendVendorReturn`.
 */
export const DISPOSITIONS = Object.freeze([
  'RESTOCK',
  'QUARANTINE',
  'SCRAP',
  'RETURN_TO_VENDOR',
]);

/**
 * The serial status each disposition drives the unit to.
 *
 * RETURN_TO_VENDOR lands on DAMAGED, not RETURNED_TO_VENDOR: the unit is
 * earmarked, not gone. `sendVendorReturn` is what sets RETURNED_TO_VENDOR, in
 * the same transaction as the movement that takes the quantity out of stock.
 */
export const DISPOSITION_SERIAL_STATUS = Object.freeze({
  RESTOCK: 'AVAILABLE',
  QUARANTINE: 'DAMAGED',
  SCRAP: 'SCRAPPED',
  RETURN_TO_VENDOR: 'DAMAGED',
});

/** Dispositions that take the goods out of stock there and then. */
export const DISPOSITIONS_LEAVING_STOCK = Object.freeze(['SCRAP']);

/**
 * Customer return workflow.
 *
 * APPROVED is separate from RECEIVED because authorising a return and the goods
 * turning up are different events, often days apart, and a warehouse must be
 * able to refuse a box that nobody authorised.
 */
export const CUSTOMER_RETURN_TRANSITIONS = Object.freeze({
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['CLOSED'],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
});

/**
 * Vendor return workflow.
 *
 * SENT is terminal for the stock — the goods have physically left and the
 * serials are at RETURNED_TO_VENDOR, which the serial table makes a dead end.
 * CLOSED records that the commercial side (credit note, replacement) is settled.
 */
export const VENDOR_RETURN_TRANSITIONS = Object.freeze({
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  SENT: ['CLOSED'],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
});

export function canMoveCustomerReturn(from, to) {
  return (CUSTOMER_RETURN_TRANSITIONS[from] ?? []).includes(to);
}

export function canMoveVendorReturn(from, to) {
  return (VENDOR_RETURN_TRANSITIONS[from] ?? []).includes(to);
}

/** Which bucket a vendor return may draw from. */
export const VENDOR_RETURN_SOURCE_BUCKETS = Object.freeze(['AVAILABLE', 'DAMAGED']);

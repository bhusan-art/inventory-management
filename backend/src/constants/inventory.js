/**
 * Inventory buckets.
 *
 * Total stock is the sum of these. A unit is in exactly one bucket at a time,
 * and every movement is either a transfer between buckets or an entry/exit
 * from the system.
 *
 * Tracking buckets rather than a single quantity is what lets the ledger
 * explain why available stock fell while total stock did not — the question a
 * warehouse asks constantly and a net-quantity ledger cannot answer.
 */
export const BUCKETS = Object.freeze({
  AVAILABLE: 'availableQuantity',
  RESERVED: 'reservedQuantity',
  DAMAGED: 'damagedQuantity',
  IN_TRANSIT: 'inTransitQuantity',
  UNDER_SERVICE: 'underServiceQuantity',
});

export const BUCKET_NAMES = Object.freeze(Object.keys(BUCKETS));

export const TRANSACTION_TYPES = Object.freeze([
  'PURCHASE_RECEIVED',
  'DISPATCH',
  'CUSTOMER_RETURN',
  'VENDOR_RETURN',
  'DAMAGED',
  'STOCK_ADJUSTMENT',
  'WAREHOUSE_TRANSFER',
  'SERVICE_OUT',
  'SERVICE_RETURN',
  'REPLACEMENT',
  'RESERVATION',
  'RESERVATION_RELEASE',
  'SCRAP',
]);

export const REFERENCE_TYPES = Object.freeze([
  'GRN', 'DISPATCH_NOTE', 'TRANSFER', 'RETURN', 'ADJUSTMENT', 'SERVICE',
]);

export const ADJUSTMENT_REASONS = Object.freeze([
  'PHYSICAL_COUNT', 'DAMAGE', 'THEFT', 'EXPIRY', 'DATA_CORRECTION', 'FOUND_STOCK',
]);

/**
 * Serial number custody status transitions (ARCHITECTURE.md §6.1).
 *
 * Anything not listed is rejected. The table is exhaustively tested, so a
 * future edit cannot quietly widen it.
 *
 * Note the absence of AVAILABLE → DISPATCHED: a dispatch must pass through
 * RESERVED, and that reservation is the atomic claim that makes "a serial can
 * never be dispatched twice" a database guarantee rather than a promise.
 */
export const SERIAL_STATUSES = Object.freeze([
  'RECEIVED', 'AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'DISPATCHED',
  'UNDER_SERVICE', 'REPLACED', 'RETURNED_BY_CUSTOMER', 'DAMAGED',
  'SCRAPPED', 'RETURNED_TO_VENDOR',
]);

export const SERIAL_TRANSITIONS = Object.freeze({
  __NEW__: ['RECEIVED'],
  RECEIVED: ['AVAILABLE', 'DAMAGED', 'RETURNED_TO_VENDOR'],
  AVAILABLE: ['RESERVED', 'IN_TRANSIT', 'DAMAGED', 'SCRAPPED', 'RETURNED_TO_VENDOR'],
  RESERVED: ['DISPATCHED', 'AVAILABLE'],
  IN_TRANSIT: ['AVAILABLE', 'DAMAGED'],
  DISPATCHED: ['UNDER_SERVICE', 'RETURNED_BY_CUSTOMER'],
  UNDER_SERVICE: ['DISPATCHED', 'REPLACED', 'SCRAPPED'],
  REPLACED: ['RETURNED_TO_VENDOR', 'SCRAPPED'],
  RETURNED_BY_CUSTOMER: ['AVAILABLE', 'DAMAGED', 'SCRAPPED', 'RETURNED_TO_VENDOR'],
  DAMAGED: ['AVAILABLE', 'SCRAPPED', 'RETURNED_TO_VENDOR'],
  SCRAPPED: [],
  RETURNED_TO_VENDOR: [],
});

export function canTransition(from, to) {
  return (SERIAL_TRANSITIONS[from ?? '__NEW__'] ?? []).includes(to);
}

/** Which bucket a serial in a given status contributes to, or null if it has left stock. */
export const STATUS_BUCKET = Object.freeze({
  RECEIVED: 'AVAILABLE',
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  IN_TRANSIT: 'IN_TRANSIT',
  UNDER_SERVICE: 'UNDER_SERVICE',
  DAMAGED: 'DAMAGED',
  DISPATCHED: null,
  REPLACED: null,
  RETURNED_BY_CUSTOMER: 'DAMAGED',
  SCRAPPED: null,
  RETURNED_TO_VENDOR: null,
});

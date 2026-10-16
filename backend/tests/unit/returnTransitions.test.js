import {
  CUSTOMER_RETURN_TRANSITIONS, VENDOR_RETURN_TRANSITIONS,
  canMoveCustomerReturn, canMoveVendorReturn,
  DISPOSITIONS, DISPOSITION_SERIAL_STATUS, DISPOSITIONS_LEAVING_STOCK,
} from '../../src/constants/returns.js';
import { SERIAL_TRANSITIONS, STATUS_BUCKET, canTransition } from '../../src/constants/inventory.js';

/**
 * Both tables asserted exhaustively — every (from, to) pair, not a sample.
 * A future edit that widens a table fails here rather than in production.
 */
function assertEveryPair(table, canMove) {
  const states = Object.keys(table);

  for (const from of states) {
    for (const to of states) {
      const allowed = table[from].includes(to);
      expect([from, to, canMove(from, to)]).toEqual([from, to, allowed]);
    }
  }
}

describe('customer return workflow', () => {
  it('allows exactly the listed transitions and nothing else', () => {
    assertEveryPair(CUSTOMER_RETURN_TRANSITIONS, canMoveCustomerReturn);
  });

  it('will not let goods be received before the return is approved', () => {
    // The warehouse must be able to refuse a box nobody authorised.
    expect(canMoveCustomerReturn('DRAFT', 'RECEIVED')).toBe(false);
    expect(canMoveCustomerReturn('PENDING_APPROVAL', 'RECEIVED')).toBe(false);
    expect(canMoveCustomerReturn('APPROVED', 'RECEIVED')).toBe(true);
  });

  it('makes rejection and cancellation terminal', () => {
    expect(CUSTOMER_RETURN_TRANSITIONS.REJECTED).toEqual([]);
    expect(CUSTOMER_RETURN_TRANSITIONS.CANCELLED).toEqual([]);
    expect(CUSTOMER_RETURN_TRANSITIONS.CLOSED).toEqual([]);
  });

  it('cannot reopen a received return as a draft', () => {
    expect(canMoveCustomerReturn('RECEIVED', 'DRAFT')).toBe(false);
    expect(canMoveCustomerReturn('RECEIVED', 'APPROVED')).toBe(false);
  });

  it('rejects an unknown state rather than defaulting to permissive', () => {
    expect(canMoveCustomerReturn('NONSENSE', 'APPROVED')).toBe(false);
    expect(canMoveCustomerReturn(undefined, 'APPROVED')).toBe(false);
  });
});

describe('vendor return workflow', () => {
  it('allows exactly the listed transitions and nothing else', () => {
    assertEveryPair(VENDOR_RETURN_TRANSITIONS, canMoveVendorReturn);
  });

  it('will not send goods that were never approved', () => {
    expect(canMoveVendorReturn('DRAFT', 'SENT')).toBe(false);
    expect(canMoveVendorReturn('PENDING_APPROVAL', 'SENT')).toBe(false);
    expect(canMoveVendorReturn('APPROVED', 'SENT')).toBe(true);
  });

  it('cannot un-send a return', () => {
    expect(canMoveVendorReturn('SENT', 'APPROVED')).toBe(false);
    expect(canMoveVendorReturn('SENT', 'CANCELLED')).toBe(false);
    expect(canMoveVendorReturn('SENT', 'CLOSED')).toBe(true);
  });
});

describe('dispositions', () => {
  it('maps every disposition to a serial status', () => {
    for (const disposition of DISPOSITIONS) {
      expect(DISPOSITION_SERIAL_STATUS[disposition]).toBeTruthy();
    }
  });

  it('drives only statuses the serial table can actually reach from a return', () => {
    // A disposition that named an unreachable status would fail at runtime
    // inside a transaction, which is a poor place to discover it.
    for (const disposition of DISPOSITIONS) {
      const target = DISPOSITION_SERIAL_STATUS[disposition];
      expect(canTransition('RETURNED_BY_CUSTOMER', target)).toBe(true);
    }
  });

  it('earmarks a vendor return without taking the unit out of stock', () => {
    // The goods are still in our building until the RTV ships. If this said
    // RETURNED_TO_VENDOR, the serial would leave stock while the quantity
    // stayed in the DAMAGED bucket — drift of our own making.
    expect(DISPOSITION_SERIAL_STATUS.RETURN_TO_VENDOR).toBe('DAMAGED');
    expect(STATUS_BUCKET.DAMAGED).toBe('DAMAGED');
    expect(DISPOSITIONS_LEAVING_STOCK).not.toContain('RETURN_TO_VENDOR');
  });

  it('agrees with STATUS_BUCKET about which dispositions leave stock', () => {
    for (const disposition of DISPOSITIONS) {
      const target = DISPOSITION_SERIAL_STATUS[disposition];
      const leavesStock = STATUS_BUCKET[target] === null;
      expect([disposition, leavesStock])
        .toEqual([disposition, DISPOSITIONS_LEAVING_STOCK.includes(disposition)]);
    }
  });

  it('restocks into AVAILABLE and nowhere else', () => {
    expect(DISPOSITION_SERIAL_STATUS.RESTOCK).toBe('AVAILABLE');
    expect(STATUS_BUCKET.AVAILABLE).toBe('AVAILABLE');
  });

  it('makes a scrapped unit terminal', () => {
    expect(DISPOSITION_SERIAL_STATUS.SCRAP).toBe('SCRAPPED');
    expect(SERIAL_TRANSITIONS.SCRAPPED).toEqual([]);
  });
});

describe('the return path through the serial table', () => {
  it('only accepts a return from a unit we actually dispatched', () => {
    expect(canTransition('DISPATCHED', 'RETURNED_BY_CUSTOMER')).toBe(true);
    // Nothing else may claim to have been returned by a customer.
    for (const from of Object.keys(SERIAL_TRANSITIONS)) {
      if (from === 'DISPATCHED') continue;
      expect([from, canTransition(from, 'RETURNED_BY_CUSTOMER')]).toEqual([from, false]);
    }
  });

  it('quarantines a returned unit rather than making it sellable', () => {
    expect(STATUS_BUCKET.RETURNED_BY_CUSTOMER).toBe('DAMAGED');
    expect(STATUS_BUCKET.RETURNED_BY_CUSTOMER).not.toBe('AVAILABLE');
  });

  it('makes a unit sent back to a vendor a dead end', () => {
    expect(SERIAL_TRANSITIONS.RETURNED_TO_VENDOR).toEqual([]);
    expect(STATUS_BUCKET.RETURNED_TO_VENDOR).toBeNull();
  });
});

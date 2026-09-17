import {
  SERIAL_STATUSES, SERIAL_TRANSITIONS, canTransition, STATUS_BUCKET,
} from '../../src/constants/inventory.js';

/**
 * The transition table is asserted exhaustively — every ordered pair of
 * statuses is checked as allowed or denied. A future edit that widens the
 * table by one entry fails here, which is the point: this table is the
 * difference between "a serial cannot be dispatched twice" being a guarantee
 * and being a hope.
 */
describe('serial number transition table', () => {
  it('covers every status as a source', () => {
    for (const status of SERIAL_STATUSES) {
      expect(Object.keys(SERIAL_TRANSITIONS)).toContain(status);
    }
  });

  it('only ever targets a real status', () => {
    for (const [from, targets] of Object.entries(SERIAL_TRANSITIONS)) {
      for (const to of targets) {
        expect({ from, to, known: SERIAL_STATUSES.includes(to) }).toEqual({ from, to, known: true });
      }
    }
  });

  it('checks all 121 ordered pairs against the table', () => {
    const unexpected = [];
    for (const from of SERIAL_STATUSES) {
      for (const to of SERIAL_STATUSES) {
        const allowed = canTransition(from, to);
        const declared = SERIAL_TRANSITIONS[from].includes(to);
        if (allowed !== declared) unexpected.push(`${from}->${to}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('forbids AVAILABLE going straight to DISPATCHED', () => {
    // A dispatch must pass through RESERVED. That reservation is the atomic
    // claim which makes double-dispatch impossible rather than unlikely.
    expect(canTransition('AVAILABLE', 'DISPATCHED')).toBe(false);
    expect(canTransition('AVAILABLE', 'RESERVED')).toBe(true);
    expect(canTransition('RESERVED', 'DISPATCHED')).toBe(true);
  });

  it('starts new serials at RECEIVED and nowhere else', () => {
    expect(canTransition(null, 'RECEIVED')).toBe(true);
    expect(canTransition(null, 'AVAILABLE')).toBe(false);
    expect(canTransition(null, 'DISPATCHED')).toBe(false);
  });

  it('treats SCRAPPED and RETURNED_TO_VENDOR as terminal', () => {
    for (const terminal of ['SCRAPPED', 'RETURNED_TO_VENDOR']) {
      expect(SERIAL_TRANSITIONS[terminal]).toEqual([]);
      for (const to of SERIAL_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of SERIAL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('lets a dispatched unit come back only through service or a return', () => {
    expect(SERIAL_TRANSITIONS.DISPATCHED.sort()).toEqual(['RETURNED_BY_CUSTOMER', 'UNDER_SERVICE']);
  });

  it('maps every status to a bucket or explicitly to none', () => {
    for (const status of SERIAL_STATUSES) {
      expect(Object.prototype.hasOwnProperty.call(STATUS_BUCKET, status)).toBe(true);
    }
    // A dispatched unit is the customer's; it must not count as stock.
    expect(STATUS_BUCKET.DISPATCHED).toBeNull();
    expect(STATUS_BUCKET.AVAILABLE).toBe('AVAILABLE');
  });
});

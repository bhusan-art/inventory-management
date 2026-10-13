import { addMonths, daysBetween, warrantyStatus, daysRemaining } from '../../src/utils/dates.js';

/**
 * Warranty arithmetic.
 *
 * The month-end cases are the reason this file exists. `setMonth` overflows
 * rather than clamping, so a naive implementation gives away free cover on
 * every warranty sold at the end of a month — quietly, forever.
 */
describe('addMonths', () => {
  it('adds whole months', () => {
    expect(addMonths(new Date('2026-09-10'), 36).toISOString().slice(0, 10)).toBe('2029-09-10');
    expect(addMonths(new Date('2026-01-15'), 1).toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('clamps 31 January rather than rolling into March', () => {
    // setMonth would produce 3 March — three days of warranty nobody sold.
    expect(addMonths(new Date('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(addMonths(new Date('2028-01-31'), 1).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('handles 29 February plus one year', () => {
    expect(addMonths(new Date('2028-02-29'), 12).toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('clamps 31 May into a 30-day June', () => {
    expect(addMonths(new Date('2026-05-31'), 1).toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('crosses year boundaries', () => {
    expect(addMonths(new Date('2026-11-15'), 3).toISOString().slice(0, 10)).toBe('2027-02-15');
    expect(addMonths(new Date('2026-12-31'), 24).toISOString().slice(0, 10)).toBe('2028-12-31');
  });

  it('does not mutate the input', () => {
    const original = new Date('2026-01-31');
    addMonths(original, 6);
    expect(original.toISOString().slice(0, 10)).toBe('2026-01-31');
  });

  it('treats zero months as same-day', () => {
    expect(addMonths(new Date('2026-05-15'), 0).toISOString().slice(0, 10)).toBe('2026-05-15');
  });
});

describe('daysBetween', () => {
  it('ignores the time of day', () => {
    expect(daysBetween(new Date('2026-05-01T23:59:00'), new Date('2026-05-02T00:01:00'))).toBe(1);
  });

  it('is negative when the target has passed', () => {
    expect(daysBetween(new Date('2026-05-10'), new Date('2026-05-01'))).toBe(-9);
  });

  it('counts across a month boundary', () => {
    expect(daysBetween(new Date('2026-01-31'), new Date('2026-03-01'))).toBe(29);
  });
});

describe('warrantyStatus', () => {
  const now = new Date('2026-06-15');
  const at = (endDate, state = 'ACTIVE') => ({ endDate: new Date(endDate), state });

  it('is ACTIVE well before expiry', () => {
    expect(warrantyStatus(at('2027-06-15'), now)).toBe('ACTIVE');
  });

  it('is EXPIRING_SOON inside 30 days', () => {
    expect(warrantyStatus(at('2026-07-10'), now)).toBe('EXPIRING_SOON');
    expect(warrantyStatus(at('2026-07-15'), now)).toBe('EXPIRING_SOON'); // exactly 30
  });

  it('is ACTIVE at 31 days — the boundary is inclusive on the warning side only', () => {
    expect(warrantyStatus(at('2026-07-16'), now)).toBe('ACTIVE');
  });

  it('is EXPIRING_SOON on the final day, not EXPIRED', () => {
    // Cover runs to the end of the day it expires.
    expect(warrantyStatus(at('2026-06-15'), now)).toBe('EXPIRING_SOON');
  });

  it('is EXPIRED the day after', () => {
    expect(warrantyStatus(at('2026-06-14'), now)).toBe('EXPIRED');
  });

  it('reports a stored state ahead of the dates', () => {
    // A voided warranty is void whatever the calendar says.
    expect(warrantyStatus(at('2027-06-15', 'VOID'), now)).toBe('VOID');
    expect(warrantyStatus(at('2027-06-15', 'CLAIMED_REPLACED'), now)).toBe('REPLACED');
  });

  it('handles a missing warranty', () => {
    expect(warrantyStatus(null)).toBeNull();
    expect(daysRemaining(null)).toBeNull();
  });
});

describe('a real warranty period', () => {
  it('matches the specification example exactly', () => {
    // ARCHITECTURE.md: dispatched 2026-09-10, 36 months → 2029-09-10.
    const end = addMonths(new Date('2026-09-10'), 36);
    expect(end.toISOString().slice(0, 10)).toBe('2029-09-10');
    expect(warrantyStatus({ endDate: end, state: 'ACTIVE' }, new Date('2029-09-11'))).toBe('EXPIRED');
    expect(warrantyStatus({ endDate: end, state: 'ACTIVE' }, new Date('2029-09-10'))).toBe('EXPIRING_SOON');
  });
});

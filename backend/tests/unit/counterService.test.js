import { financialYear } from '../../src/services/shared/counterService.js';

describe('financial year', () => {
  it('runs April to March by default', () => {
    expect(financialYear(new Date('2026-04-01'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31'))).toBe('2026-27');
    expect(financialYear(new Date('2027-04-01'))).toBe('2027-28');
  });

  it('puts January in the previous year’s FY', () => {
    // The off-by-one that produces two documents numbered 00001 in the same
    // year, discovered at audit time.
    expect(financialYear(new Date('2027-01-15'))).toBe('2026-27');
  });

  it('handles a century boundary in the short suffix', () => {
    expect(financialYear(new Date('2099-06-01'))).toBe('2099-00');
  });

  it('honours a different start month', () => {
    expect(financialYear(new Date('2026-06-01'), 7)).toBe('2025-26');
    expect(financialYear(new Date('2026-07-01'), 7)).toBe('2026-27');
  });
});

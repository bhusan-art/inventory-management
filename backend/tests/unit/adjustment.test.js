import { validateAdjustment } from '../../src/services/inventory/adjustmentService.js';
import { ADJUSTMENT_REASONS } from '../../src/constants/inventory.js';

const base = {
  currentQuantity: 100,
  newQuantity: 95,
  reasonCode: 'PHYSICAL_COUNT',
  remarks: 'Recount after cycle check',
  permissions: new Set(['ADJUST_INVENTORY']),
};

describe('validateAdjustment — basic rules', () => {
  it('allows a small correction', () => {
    const result = validateAdjustment(base);
    expect(result.delta).toBe(-5);
    expect(result.requiresElevation).toBe(false);
  });

  it('refuses an unchanged quantity', () => {
    expect(() => validateAdjustment({ ...base, newQuantity: 100 }))
      .toThrow(/nothing to adjust/);
  });

  it('refuses a negative result', () => {
    expect(() => validateAdjustment({ ...base, newQuantity: -1 }))
      .toThrow(/below zero/);
  });

  it('reports a negative quantity as negative, not as no-change', () => {
    // -5 vs -5 is "unchanged" arithmetically but the real problem is the
    // negative number, and that is what the user needs told.
    try {
      validateAdjustment({ ...base, currentQuantity: -5, newQuantity: -5 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('NEGATIVE_STOCK');
    }
  });

  it('refuses a fractional quantity', () => {
    expect(() => validateAdjustment({ ...base, newQuantity: 95.5 }))
      .toThrow(/whole number/);
  });

  it('requires a known reason code', () => {
    expect(() => validateAdjustment({ ...base, reasonCode: 'BECAUSE' }))
      .toThrow(/reason code/);
    expect(() => validateAdjustment({ ...base, reasonCode: undefined }))
      .toThrow(/reason code/);
  });

  it('accepts every declared reason code', () => {
    for (const reasonCode of ADJUSTMENT_REASONS) {
      expect(() => validateAdjustment({ ...base, reasonCode })).not.toThrow();
    }
  });
});

describe('validateAdjustment — the threshold', () => {
  it('uses the unit floor for small holdings', () => {
    // 5% of 20 is 1, so the 10-unit floor governs.
    const result = validateAdjustment({
      ...base, currentQuantity: 20, newQuantity: 12, permissions: new Set(['ADJUST_INVENTORY']),
    });
    expect(result.threshold).toBe(10);
    expect(result.requiresElevation).toBe(false);
  });

  it('uses the percentage for large holdings', () => {
    // 5% of 10,000 is 500, comfortably above the 10-unit floor.
    const result = validateAdjustment({
      ...base, currentQuantity: 10_000, newQuantity: 9_700, remarks: 'Reel remeasured after cutting',
    });
    expect(result.threshold).toBe(500);
    expect(result.requiresElevation).toBe(false);
  });

  it('blocks a change beyond the threshold without elevation', () => {
    expect(() => validateAdjustment({
      ...base, currentQuantity: 20, newQuantity: 0, remarks: 'All units missing from the rack',
    })).toThrow(/exceeds your limit/);
  });

  it('allows the same change with ADJUST_INVENTORY_UNLIMITED', () => {
    const result = validateAdjustment({
      ...base,
      currentQuantity: 20,
      newQuantity: 0,
      remarks: 'All units missing from the rack',
      permissions: new Set(['ADJUST_INVENTORY', 'ADJUST_INVENTORY_UNLIMITED']),
    });
    expect(result.requiresElevation).toBe(true);
    expect(result.delta).toBe(-20);
  });

  it('treats increases and decreases identically', () => {
    const permissions = new Set(['ADJUST_INVENTORY']);
    expect(() => validateAdjustment({ ...base, currentQuantity: 20, newQuantity: 45, permissions }))
      .toThrow(/exceeds your limit/);
  });

  it('respects configured thresholds', () => {
    const result = validateAdjustment({
      ...base, currentQuantity: 100, newQuantity: 130,
      thresholdUnits: 50, thresholdPercent: 1,
      permissions: new Set(['ADJUST_INVENTORY']),
    });
    expect(result.threshold).toBe(50);
    expect(result.requiresElevation).toBe(false);
  });

  it('is exactly at the threshold, not over it, at the boundary', () => {
    // 10 units on a 20-unit holding: threshold is max(10, 1) = 10, so a change
    // of exactly 10 must pass and 11 must not.
    const permissions = new Set(['ADJUST_INVENTORY']);
    expect(() => validateAdjustment({ ...base, currentQuantity: 20, newQuantity: 30, permissions }))
      .not.toThrow();
    expect(() => validateAdjustment({ ...base, currentQuantity: 20, newQuantity: 31, permissions }))
      .toThrow(/exceeds your limit/);
  });
});

describe('validateAdjustment — remarks', () => {
  const elevated = new Set(['ADJUST_INVENTORY', 'ADJUST_INVENTORY_UNLIMITED']);

  it('requires an explanation for a large change', () => {
    expect(() => validateAdjustment({
      ...base, currentQuantity: 20, newQuantity: 0, remarks: 'lost', permissions: elevated,
    })).toThrow(/written explanation/);
  });

  it('rejects whitespace padding as an explanation', () => {
    expect(() => validateAdjustment({
      ...base, currentQuantity: 20, newQuantity: 0, remarks: '             ', permissions: elevated,
    })).toThrow(/written explanation/);
  });

  it('does not require remarks for a small change', () => {
    expect(() => validateAdjustment({ ...base, remarks: undefined })).not.toThrow();
  });
});

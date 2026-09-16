import mongoose from 'mongoose';
import { sanitizeUserFilter, listQuerySchema } from '../../src/validators/common.schema.js';

/**
 * Regression tests for the injection boundary.
 *
 * The first block proves untrusted input cannot smuggle operators through.
 * The second proves the fix did not reintroduce the problem it replaced:
 * mongoose's global `sanitizeFilter` must stay off, because it mangles the
 * guarded updates the inventory ledger depends on.
 */
describe('sanitizeUserFilter', () => {
  it('keeps ordinary scalar filters', () => {
    expect(sanitizeUserFilter({ status: 'ACTIVE', department: 'Ops' }))
      .toEqual({ status: 'ACTIVE', department: 'Ops' });
  });

  it('drops operator objects — ?filter[status][$ne]=null cannot match everything', () => {
    expect(sanitizeUserFilter({ status: { $ne: null } })).toEqual({});
  });

  it('drops top-level operator keys', () => {
    expect(sanitizeUserFilter({ $where: 'this.x === 1', status: 'ACTIVE' }))
      .toEqual({ status: 'ACTIVE' });
  });

  it('drops $regex and $gt smuggled as nested objects', () => {
    expect(sanitizeUserFilter({ email: { $regex: '.*' }, createdAt: { $gt: 0 } })).toEqual({});
  });

  it('handles absent or malformed input', () => {
    expect(sanitizeUserFilter(null)).toEqual({});
    expect(sanitizeUserFilter('not an object')).toEqual({});
  });

  it('is applied by the list query schema', () => {
    const parsed = listQuerySchema.parse({ filter: { status: { $ne: null }, name: 'x' } });
    expect(parsed.filter).toEqual({ name: 'x' });
  });
});

describe('mongoose global settings', () => {
  it('leaves sanitizeFilter off so developer-written operators survive', () => {
    // With it on, the negative-stock guard below silently stops matching and
    // every inventory decrement fails without an error.
    expect(mongoose.get('sanitizeFilter')).toBeFalsy();
  });

  it('keeps the guarded stock update intact', () => {
    const guard = { _id: 'x', availableQuantity: { $gte: 5 } };
    const afterGlobalSanitize = mongoose.sanitizeFilter({ ...guard });

    // Demonstrates exactly what the global setting would have done.
    expect(afterGlobalSanitize).toEqual({ _id: 'x', availableQuantity: { $eq: { $gte: 5 } } });
    expect(guard.availableQuantity.$gte).toBe(5);
  });
});

import mongoose from 'mongoose';
import { toObjectId, toObjectIds } from '../../src/utils/objectId.js';

/**
 * These tests document an asymmetry in Mongoose that cost this project seven
 * silently-empty aggregations across two phases.
 *
 *   find({ tenantId: '6acf…' })                    → cast against the schema
 *   aggregate([{ $match: { tenantId: '6acf…' } }]) → sent as a STRING
 *
 * The second matches nothing and returns an empty result with no error. Zero
 * is a plausible answer, which is why it survived: a dashboard reading
 * "0 units" looks like an empty warehouse, not a broken query.
 */
describe('toObjectId', () => {
  const hex = '6acf10dd84f6247fbfa73783';

  it('converts a hex string to an ObjectId', () => {
    const id = toObjectId(hex);
    expect(id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(id)).toBe(hex);
  });

  it('passes an ObjectId through untouched', () => {
    const original = new mongoose.Types.ObjectId(hex);
    expect(toObjectId(original)).toBe(original);
  });

  it('leaves null and undefined alone', () => {
    expect(toObjectId(null)).toBeNull();
    expect(toObjectId(undefined)).toBeUndefined();
  });

  it('throws on something that is not an id, rather than returning a dud', () => {
    // Failing loudly is the whole point: the bug being fixed here was one that
    // failed silently.
    expect(() => toObjectId('not-an-id')).toThrow(/Not a valid ObjectId/);
    expect(() => toObjectId('')).toThrow();
  });

  it('casts a list', () => {
    const ids = toObjectIds([hex, new mongoose.Types.ObjectId(hex)]);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('is not equal to its own string form, which is the whole problem', () => {
    // This is the comparison MongoDB makes inside a pipeline. A string and an
    // ObjectId are different BSON types, so the match simply fails.
    const id = toObjectId(hex);
    expect(id).not.toBe(hex);
    expect(id.equals(hex)).toBe(true);        // explicit comparison works
    expect(String(id) === hex).toBe(true);    // so does string comparison
    // But the raw values are not interchangeable in a query document:
    expect(typeof hex).toBe('string');
    expect(typeof id).toBe('object');
  });
});

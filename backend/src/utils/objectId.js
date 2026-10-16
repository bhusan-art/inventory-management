import mongoose from 'mongoose';

/**
 * Casts an id for use inside an AGGREGATION PIPELINE.
 *
 * This exists because of an asymmetry in Mongoose that is easy to miss and
 * fails silently:
 *
 *   Model.find({ tenantId })                     casts the string for you
 *   Model.aggregate([{ $match: { tenantId } }])  DOES NOT
 *
 * `find` consults the schema and converts a hex string to an ObjectId.
 * An aggregation pipeline is passed to the server almost verbatim — Mongoose
 * has no per-stage schema to cast against — so a string is compared to stored
 * ObjectIds, matches nothing, and the pipeline returns an EMPTY RESULT. No
 * error, no warning. Just zero.
 *
 * `actor.tenantId` is a string (`permissionResolver` stores `String(...)`), so
 * every aggregation in this codebase that matched on it was quietly returning
 * nothing: the dashboard's stock and activity panels, the document storage
 * summary, and the serial consistency audit — a function whose entire purpose
 * is proving two numbers agree, which cannot do that against an empty set.
 *
 * Zero is a plausible-looking answer, which is what makes this worse than a
 * crash. A dashboard reading "0 units" looks like an empty warehouse rather
 * than a broken query.
 */
export function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (value == null) return value;

  const asString = String(value);
  if (!mongoose.Types.ObjectId.isValid(asString)) {
    throw new TypeError(`Not a valid ObjectId: ${asString}`);
  }
  return new mongoose.Types.ObjectId(asString);
}

/** Casts several at once, for pipelines matching on more than one id. */
export function toObjectIds(values) {
  return values.map(toObjectId);
}

export default toObjectId;

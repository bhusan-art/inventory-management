import mongoose from 'mongoose';

/**
 * Atomic sequence generator for document numbers (PO, GRN, dispatch note...).
 *
 * Never derive a document number from a count of existing documents: two
 * concurrent requests both read the same count and produce the same number,
 * and duplicate purchase order numbers are a compliance problem rather than a
 * cosmetic one. `$inc` with `upsert` is atomic even under contention.
 *
 * Present in Phase 0 because the transaction round-trip test needs a real
 * model to exercise, and this is the one piece of schema every later module
 * will use.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // e.g. "PO:2026-27"
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false, timestamps: true },
);

export const Counter = mongoose.model('Counter', counterSchema);

/**
 * @param {string} key   sequence key, typically `${docType}:${financialYear}`
 * @param {object} opts  { session } — always pass the session when inside a transaction
 */
export async function nextSequence(key, { session } = {}) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session },
  );
  return doc.seq;
}

export default Counter;

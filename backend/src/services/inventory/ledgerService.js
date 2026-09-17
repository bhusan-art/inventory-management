import { Inventory } from '../../models/Inventory.js';
import { InventoryTransaction } from '../../models/InventoryTransaction.js';
import { BUCKETS } from '../../constants/inventory.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { DomainError } from '../../utils/errors.js';

/**
 * THE SINGLE WRITE PATH FOR INVENTORY.
 *
 * No other service may import Inventory's mutation methods — an ESLint rule
 * and a test enforce it. Every quantity change in this system, in every phase,
 * goes through `applyMovement` or `moveBetweenBuckets` below.
 *
 * That constraint is what makes business rule 2 ("every inventory movement
 * creates a transaction") structurally true rather than a convention people
 * remember. There is no way to change a quantity without a ledger row, because
 * the code that changes quantities is the code that writes ledger rows.
 *
 * Every function here REQUIRES a session. Stock movements are never standalone
 * writes — they always accompany a document being posted, and if that document
 * fails the movement must not survive.
 */

function bucketField(bucket) {
  const field = BUCKETS[bucket];
  if (!field) throw new DomainError(`Unknown inventory bucket "${bucket}"`, 'UNKNOWN_BUCKET');
  return field;
}

/**
 * Adds to or removes from one bucket.
 *
 * Decrements use a guarded atomic update: the `$gte` precondition and the
 * `$inc` are one operation, so two concurrent requests for the last unit
 * cannot both succeed. A read-then-check-then-write in application code has a
 * window between the check and the write, and under load something will land
 * in it (ARCHITECTURE.md §0.8).
 *
 * Returns the ledger row that was written.
 */
export async function applyMovement({
  session,
  actor,
  product,
  warehouse,
  bucket = 'AVAILABLE',
  quantityChange,
  transactionType,
  referenceType,
  referenceId = null,
  referenceNumber = null,
  serialNumber = null,
  rackLocation = null,
  reasonCode = null,
  remarks = null,
}) {
  if (!session) throw new Error('applyMovement requires a transaction session');
  if (!Number.isInteger(quantityChange) || quantityChange === 0) {
    throw new DomainError('Quantity change must be a non-zero whole number', 'INVALID_QUANTITY');
  }

  const field = bucketField(bucket);
  const tenantId = actor.tenantId;

  let updated;

  if (quantityChange > 0) {
    // Increases cannot go negative, so no precondition is needed — but the row
    // may not exist yet, hence the upsert.
    updated = await Inventory.findOneAndUpdate(
      { tenantId, product, warehouse },
      {
        $inc: { [field]: quantityChange },
        $set: { lastTransactionAt: new Date(), ...(rackLocation ? { rackLocation } : {}) },
        $setOnInsert: { tenantId, product, warehouse },
      },
      { new: true, upsert: true, session },
    );
  } else {
    // The guard. A null result means there was not enough stock — and because
    // the precondition and the decrement are a single atomic operation, no
    // concurrent request can have slipped between them.
    updated = await Inventory.findOneAndUpdate(
      { tenantId, product, warehouse, [field]: { $gte: Math.abs(quantityChange) } },
      { $inc: { [field]: quantityChange }, $set: { lastTransactionAt: new Date() } },
      { new: true, session },
    );

    if (!updated) {
      const current = await Inventory.findOne({ tenantId, product, warehouse }).session(session);
      throw new DomainError(
        `Insufficient ${bucket.toLowerCase().replace('_', ' ')} stock: `
        + `${current?.[field] ?? 0} on hand, ${Math.abs(quantityChange)} required`,
        'INSUFFICIENT_STOCK',
        [{
          code: 'INSUFFICIENT_STOCK',
          product: String(product),
          warehouse: String(warehouse),
          bucket,
          available: current?.[field] ?? 0,
          requested: Math.abs(quantityChange),
        }],
      );
    }
  }

  const quantityAfter = updated[field];
  // Derived from what the database returned, never from a value read before
  // the update. This is what keeps the ledger arithmetically self-consistent
  // under concurrency.
  const quantityBefore = quantityAfter - quantityChange;

  const transactionNumber = await nextDocumentNumber('TXN', { session });

  const [entry] = await InventoryTransaction.create([{
    tenantId,
    transactionNumber,
    transactionType,
    direction: quantityChange > 0 ? 'IN' : 'OUT',
    product,
    serialNumber,
    warehouse,
    bucketFrom: quantityChange > 0 ? null : bucket,
    bucketTo: quantityChange > 0 ? bucket : null,
    quantityBefore,
    quantityChange,
    quantityAfter,
    referenceType,
    referenceId,
    referenceNumber,
    reasonCode,
    performedBy: actor.id,
    remarks,
  }], { session });

  return entry;
}

/**
 * Moves quantity between two buckets at the same location — available to
 * reserved, available to damaged, and so on.
 *
 * Written as one function rather than two `applyMovement` calls because the
 * total must not change: doing it as a separate OUT and IN leaves a moment,
 * and a possible failure point, where the stock exists in neither bucket.
 */
export async function moveBetweenBuckets({
  session, actor, product, warehouse, fromBucket, toBucket, quantity,
  transactionType, referenceType, referenceId = null, referenceNumber = null,
  serialNumber = null, reasonCode = null, remarks = null,
}) {
  if (!session) throw new Error('moveBetweenBuckets requires a transaction session');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new DomainError('Quantity must be a positive whole number', 'INVALID_QUANTITY');
  }
  if (fromBucket === toBucket) {
    throw new DomainError('Source and destination buckets must differ', 'INVALID_BUCKET_MOVE');
  }

  const fromField = bucketField(fromBucket);
  const toField = bucketField(toBucket);
  const tenantId = actor.tenantId;

  const updated = await Inventory.findOneAndUpdate(
    { tenantId, product, warehouse, [fromField]: { $gte: quantity } },
    { $inc: { [fromField]: -quantity, [toField]: quantity }, $set: { lastTransactionAt: new Date() } },
    { new: true, session },
  );

  if (!updated) {
    const current = await Inventory.findOne({ tenantId, product, warehouse }).session(session);
    throw new DomainError(
      `Insufficient ${fromBucket.toLowerCase().replace('_', ' ')} stock: `
      + `${current?.[fromField] ?? 0} on hand, ${quantity} required`,
      'INSUFFICIENT_STOCK',
      [{
        code: 'INSUFFICIENT_STOCK',
        bucket: fromBucket,
        available: current?.[fromField] ?? 0,
        requested: quantity,
      }],
    );
  }

  const transactionNumber = await nextDocumentNumber('TXN', { session });

  const [entry] = await InventoryTransaction.create([{
    tenantId,
    transactionNumber,
    transactionType,
    direction: 'NEUTRAL', // total stock unchanged
    product,
    serialNumber,
    warehouse,
    bucketFrom: fromBucket,
    bucketTo: toBucket,
    quantityBefore: updated[toField] - quantity,
    quantityChange: quantity,
    quantityAfter: updated[toField],
    referenceType,
    referenceId,
    referenceNumber,
    reasonCode,
    performedBy: actor.id,
    remarks,
  }], { session });

  return entry;
}

/** Read-only helpers. Safe to call outside a transaction. */
export function getStock(tenantId, product, warehouse) {
  return Inventory.findOne({ tenantId, product, warehouse });
}

export function getStockAcrossWarehouses(tenantId, product) {
  return Inventory.find({ tenantId, product }).populate('warehouse', 'name code');
}

/**
 * Recomputes a location's buckets from the ledger.
 *
 * Reports drift rather than correcting it: a mismatch means something wrote
 * outside the single path, and silently repairing it would hide the bug that
 * caused it (ARCHITECTURE.md §0.7).
 */
export async function reconcile(tenantId, { product, warehouse } = {}) {
  const match = { tenantId };
  if (product) match.product = product;
  if (warehouse) match.warehouse = warehouse;

  const ledgerTotals = await InventoryTransaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { product: '$product', warehouse: '$warehouse' },
        net: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$direction', 'IN'] }, then: '$quantityChange' },
                { case: { $eq: ['$direction', 'OUT'] }, then: '$quantityChange' },
              ],
              default: 0, // NEUTRAL moves between buckets; total is unchanged
            },
          },
        },
      },
    },
  ]);

  const drift = [];

  for (const row of ledgerTotals) {
    const current = await Inventory.findOne({
      tenantId, product: row._id.product, warehouse: row._id.warehouse,
    });
    const actual = current
      ? current.availableQuantity + current.reservedQuantity + current.damagedQuantity
        + current.inTransitQuantity + current.underServiceQuantity
      : 0;

    if (actual !== row.net) {
      drift.push({
        product: String(row._id.product),
        warehouse: String(row._id.warehouse),
        ledgerTotal: row.net,
        inventoryTotal: actual,
        difference: actual - row.net,
      });
    }
  }

  await Inventory.updateMany(match, { $set: { lastReconciledAt: new Date() } });
  return { checked: ledgerTotals.length, drift };
}

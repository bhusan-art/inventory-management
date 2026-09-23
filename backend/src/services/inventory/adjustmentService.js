import { Inventory } from '../../models/Inventory.js';
import { Product } from '../../models/Product.js';
import { Warehouse } from '../../models/Warehouse.js';
import { ADJUSTMENT_REASONS, BUCKETS } from '../../constants/inventory.js';
import { getSettings } from '../../models/Setting.js';
import { withTransaction } from '../shared/transaction.js';
import { writeAudit } from '../shared/auditService.js';
import { assertWarehouseInScope } from '../shared/scopeService.js';
import { applyMovement, moveBetweenBuckets } from './ledgerService.js';
import { DomainError, ForbiddenError, NotFoundError } from '../../utils/errors.js';

/**
 * Stock adjustment is the one operation that can create or destroy stock from
 * nothing. Every other movement has a physical event behind it — goods arrived,
 * goods left, goods moved. An adjustment says "the number was wrong," which is
 * unfalsifiable from inside the system.
 *
 * So it carries the tightest controls: a mandatory reason code, mandatory
 * remarks on large changes, a permission ceiling above a threshold, and a
 * CRITICAL audit entry every time.
 */

/**
 * Decides whether an adjustment is allowed. Pure — no database calls, so it is
 * cheap to test exhaustively and cannot be the source of a partial write.
 *
 * @throws DomainError | ForbiddenError
 * @returns {{ delta: number, requiresElevation: boolean, threshold: number }}
 */
export function validateAdjustment({
  currentQuantity,
  newQuantity,
  reasonCode,
  remarks,
  permissions,
  thresholdUnits = 10,
  thresholdPercent = 5,
}) {
  if (!Number.isInteger(newQuantity)) {
    throw new DomainError('The counted quantity must be a whole number', 'INVALID_QUANTITY');
  }

  // Checked before the no-change rule: "-5 is the same as -5" should report the
  // real problem, not a confusing "nothing changed".
  if (newQuantity < 0) {
    throw new DomainError('An adjustment cannot leave stock below zero', 'NEGATIVE_STOCK');
  }

  const delta = newQuantity - currentQuantity;

  if (delta === 0) {
    throw new DomainError('The quantity is unchanged, so there is nothing to adjust', 'NO_CHANGE');
  }

  if (!ADJUSTMENT_REASONS.includes(reasonCode)) {
    throw new DomainError(
      `A reason code is required, and must be one of: ${ADJUSTMENT_REASONS.join(', ')}`,
      'INVALID_REASON_CODE',
      [{ code: 'INVALID_REASON_CODE', field: 'reasonCode' }],
    );
  }

  /**
   * The threshold is the LARGER of the two limits, not the smaller.
   *
   * With no monetary values to threshold on, quantity relative to holding is
   * the available proxy — and it is the right one. A 200-unit correction on a
   * 10,000-metre cable drum is routine; the same correction on servers is not.
   * Taking the larger of "10 units" and "5% of stock" means small-volume
   * products are governed by the unit floor and high-volume ones by the
   * percentage, which is the behaviour you actually want.
   */
  const percentAllowance = Math.floor((currentQuantity * thresholdPercent) / 100);
  const threshold = Math.max(thresholdUnits, percentAllowance);
  const requiresElevation = Math.abs(delta) > threshold;

  if (requiresElevation && !permissions.has('ADJUST_INVENTORY_UNLIMITED')) {
    throw new ForbiddenError(
      `This adjustment of ${Math.abs(delta)} units exceeds your limit of ${threshold}. `
      + 'It needs approval from an administrator.',
      'ADJUSTMENT_LIMIT_EXCEEDED',
      [{ code: 'ADJUSTMENT_LIMIT_EXCEEDED', delta, threshold }],
    );
  }

  // Large corrections without an explanation are exactly the ones a future
  // reader will need explained. The reason code says what kind; the remarks
  // have to say what happened.
  if (requiresElevation && (!remarks || remarks.trim().length < 10)) {
    throw new DomainError(
      'An adjustment of this size needs a written explanation of at least 10 characters',
      'REMARKS_REQUIRED',
      [{ code: 'REMARKS_REQUIRED', field: 'remarks' }],
    );
  }

  return { delta, requiresElevation, threshold };
}

/** Applies a single adjustment, inside a transaction, with its ledger row. */
export async function adjustStock(actor, payload) {
  const {
    product: productId, warehouse: warehouseId, bucket = 'AVAILABLE',
    newQuantity, reasonCode, remarks,
  } = payload;

  assertWarehouseInScope(actor, warehouseId);

  if (!BUCKETS[bucket]) throw new DomainError(`Unknown bucket "${bucket}"`, 'UNKNOWN_BUCKET');

  const [product, warehouse] = await Promise.all([
    Product.findOne({ _id: productId, tenantId: actor.tenantId, deletedAt: null }),
    Warehouse.findOne({ _id: warehouseId, tenantId: actor.tenantId, deletedAt: null }),
  ]);
  if (!product) throw new NotFoundError('Product not found');
  if (!warehouse) throw new NotFoundError('Warehouse not found');

  const thresholds = await getSettings(actor.tenantId, [
    'inventory.adjustmentThreshold.units',
    'inventory.adjustmentThreshold.percent',
  ]);

  const existing = await Inventory.findOne({
    tenantId: actor.tenantId, product: productId, warehouse: warehouseId,
  });
  const currentQuantity = existing ? existing[BUCKETS[bucket]] : 0;

  const { delta, requiresElevation, threshold } = validateAdjustment({
    currentQuantity,
    newQuantity,
    reasonCode,
    remarks,
    permissions: actor.permissions,
    thresholdUnits: thresholds['inventory.adjustmentThreshold.units'],
    thresholdPercent: thresholds['inventory.adjustmentThreshold.percent'],
  });

  /**
   * Serialized products are adjusted by changing individual serial records, not
   * by moving a number. Letting someone set "available = 7" when nine serials
   * exist would leave the quantity and the serial list disagreeing, with no way
   * to tell which two units vanished.
   */
  if (product.productType === 'SERIALIZED') {
    throw new DomainError(
      `${product.name} is serialized. Adjust individual units by their serial number `
      + 'so the quantity and the serial records stay in agreement.',
      'SERIALIZED_ADJUSTMENT_BLOCKED',
    );
  }

  return withTransaction(async ({ session, onCommit }) => {
    const entry = await applyMovement({
      session,
      actor,
      product: productId,
      warehouse: warehouseId,
      bucket,
      quantityChange: delta,
      transactionType: 'STOCK_ADJUSTMENT',
      referenceType: 'ADJUSTMENT',
      reasonCode,
      remarks,
    });

    onCommit(() => writeAudit({
      action: 'STOCK_ADJUSTED',
      module: 'Inventory',
      recordId: entry._id,
      recordLabel: `${product.sku} @ ${warehouse.code}`,
      // Always CRITICAL. This is the operation that can conjure stock.
      severity: 'CRITICAL',
      tenantId: actor.tenantId,
      changes: [{ field: `${bucket}.quantity`, before: currentQuantity, after: newQuantity }],
      metadata: { reasonCode, delta, threshold, requiresElevation, remarks },
    }));

    return entry;
  });
}

/**
 * Moves stock between buckets at one location — writing off damaged units,
 * or returning repaired ones to available.
 *
 * Separate from `adjustStock` because the total does not change: this is a
 * reclassification, not a correction, and conflating the two would make the
 * adjustment report useless for finding actual discrepancies.
 */
export async function reclassifyStock(actor, payload) {
  const { product: productId, warehouse: warehouseId, fromBucket, toBucket, quantity, reasonCode, remarks } = payload;

  assertWarehouseInScope(actor, warehouseId);

  if (!ADJUSTMENT_REASONS.includes(reasonCode)) {
    throw new DomainError('A valid reason code is required', 'INVALID_REASON_CODE');
  }

  const product = await Product.findOne({ _id: productId, tenantId: actor.tenantId, deletedAt: null });
  if (!product) throw new NotFoundError('Product not found');

  return withTransaction(async ({ session, onCommit }) => {
    const entry = await moveBetweenBuckets({
      session,
      actor,
      product: productId,
      warehouse: warehouseId,
      fromBucket,
      toBucket,
      quantity,
      transactionType: toBucket === 'DAMAGED' ? 'DAMAGED' : 'STOCK_ADJUSTMENT',
      referenceType: 'ADJUSTMENT',
      reasonCode,
      remarks,
    });

    onCommit(() => writeAudit({
      action: 'STOCK_RECLASSIFIED',
      module: 'Inventory',
      recordId: entry._id,
      recordLabel: product.sku,
      severity: 'WARNING',
      tenantId: actor.tenantId,
      metadata: { fromBucket, toBucket, quantity, reasonCode, remarks },
    }));

    return entry;
  });
}

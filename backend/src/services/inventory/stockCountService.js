import { StockCount } from '../../models/StockCount.js';
import { Inventory } from '../../models/Inventory.js';
import { Product } from '../../models/Product.js';
import { Warehouse } from '../../models/Warehouse.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { assertWarehouseInScope, warehouseScopeFilter } from '../shared/scopeService.js';
import { applyMovement } from './ledgerService.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

/**
 * Physical stock counts.
 *
 * This exists because counts are how inventory systems actually stay accurate,
 * and doing one as a hundred individual adjustments produces a hundred audit
 * entries with no coherent record of the count itself — no way to ask "what did
 * the March count find", and no way to see which products were checked and
 * agreed.
 *
 * A count is therefore a document: a snapshot, entered results, and a single
 * posting that writes every variance at once.
 */

export async function listCounts(actor, query) {
  const filter = {
    tenantId: actor.tenantId, deletedAt: null,
    ...warehouseScopeFilter(actor),
  };
  if (query.status) filter.status = query.status;

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    StockCount.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('warehouse', 'name code')
      .populate('completedBy', 'fullName'),
    StockCount.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getCount(actor, id) {
  const count = await StockCount.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('warehouse', 'name code')
    .populate('lines.product', 'name sku unitOfMeasure productType');
  if (!count) throw new NotFoundError('Stock count not found');
  assertWarehouseInScope(actor, count.warehouse?._id ?? count.warehouse);
  return count;
}

/**
 * Generates the count sheet, snapshotting system quantities as of now.
 *
 * Serialized products are excluded: counting them means scanning serials, which
 * is a different operation with a different answer shape (which units are here,
 * not how many).
 */
export async function createCount(actor, payload) {
  assertWarehouseInScope(actor, payload.warehouse);

  const warehouse = await Warehouse.findOne({
    _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!warehouse) throw new NotFoundError('Warehouse not found');

  const open = await StockCount.countDocuments({
    tenantId: actor.tenantId, warehouse: payload.warehouse,
    status: { $in: ['DRAFT', 'IN_PROGRESS'] }, deletedAt: null,
  });
  if (open > 0) {
    // Two open counts on one warehouse would each snapshot different system
    // quantities and then both post variances against them.
    throw new ConflictError(
      'There is already an open count for this warehouse. Complete or cancel it first.',
      'COUNT_ALREADY_OPEN',
    );
  }

  const productFilter = { tenantId: actor.tenantId, deletedAt: null, productType: 'NON_SERIALIZED' };
  if (payload.scope === 'CATEGORY' && payload.category) productFilter.category = payload.category;
  if (payload.scope === 'PRODUCT_LIST' && payload.products?.length) productFilter._id = { $in: payload.products };

  const products = await Product.find(productFilter).select('_id').lean();
  if (products.length === 0) {
    throw new DomainError('No countable products match this selection', 'NO_PRODUCTS_TO_COUNT');
  }

  const stock = await Inventory.find({
    tenantId: actor.tenantId,
    warehouse: payload.warehouse,
    product: { $in: products.map((p) => p._id) },
  }).lean();
  const stockByProduct = new Map(stock.map((s) => [String(s.product), s.availableQuantity]));

  const countNumber = await nextDocumentNumber('SC');

  const count = await StockCount.create({
    tenantId: actor.tenantId,
    countNumber,
    warehouse: payload.warehouse,
    scope: payload.scope ?? 'FULL',
    category: payload.category ?? null,
    status: 'IN_PROGRESS',
    snapshotAt: new Date(),
    // Products with no inventory row are included at zero — finding stock that
    // the system does not know about is one of the main reasons to count.
    lines: products.map((p) => ({
      product: p._id,
      systemQuantity: stockByProduct.get(String(p._id)) ?? 0,
      countedQuantity: null,
      counted: false,
    })),
    remarks: payload.remarks ?? null,
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'STOCK_COUNT_STARTED', module: 'StockCount', recordId: count._id,
    recordLabel: count.countNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    metadata: { warehouse: warehouse.code, lines: count.lines.length },
  });

  return getCount(actor, count._id);
}

/** Records counted quantities. Can be called repeatedly as the count proceeds. */
export async function recordCounts(actor, id, entries) {
  const count = await StockCount.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!count) throw new NotFoundError('Stock count not found');
  assertWarehouseInScope(actor, count.warehouse);

  if (count.status !== 'IN_PROGRESS') {
    throw new DomainError(`A ${count.status.toLowerCase()} count cannot be edited`, 'COUNT_NOT_EDITABLE');
  }

  for (const entry of entries) {
    const line = count.lines.id(entry.lineId);
    if (!line) throw new NotFoundError(`Count line ${entry.lineId} not found`);

    line.countedQuantity = entry.countedQuantity;
    line.variance = entry.countedQuantity - line.systemQuantity;
    line.counted = true;
    if (entry.remarks !== undefined) line.remarks = entry.remarks;
  }

  await count.save();
  return getCount(actor, count._id);
}

/**
 * Posts the count: every variance becomes a ledger entry, in one transaction.
 *
 * Uncounted lines are left alone rather than treated as zero. A line nobody
 * counted is missing data, not evidence that the stock is gone — writing all of
 * it off would be the single most destructive thing this system could do by
 * accident.
 */
export async function completeCount(actor, id, { remarks } = {}) {
  const result = await withTransaction(async ({ session, onCommit }) => {
    const count = await StockCount.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!count) throw new NotFoundError('Stock count not found');
    assertWarehouseInScope(actor, count.warehouse);
    if (count.status !== 'IN_PROGRESS') {
      throw new ConflictError('This count is no longer in progress', 'COUNT_NOT_IN_PROGRESS');
    }

    const countedLines = count.lines.filter((l) => l.counted);
    if (countedLines.length === 0) {
      throw new DomainError('No quantities have been recorded yet', 'NOTHING_COUNTED');
    }

    const variances = countedLines.filter((l) => l.variance !== 0);

    for (const line of variances) {
      await applyMovement({
        session,
        actor,
        product: line.product,
        warehouse: count.warehouse,
        bucket: 'AVAILABLE',
        quantityChange: line.variance,
        transactionType: 'STOCK_ADJUSTMENT',
        referenceType: 'ADJUSTMENT',
        referenceId: count._id,
        referenceNumber: count.countNumber,
        reasonCode: 'PHYSICAL_COUNT',
        remarks: line.remarks ?? `Physical count ${count.countNumber}`,
      });
    }

    count.status = 'COMPLETED';
    count.completedAt = new Date();
    count.completedBy = actor.id;
    if (remarks) count.remarks = remarks;
    await count.save({ session });

    const summary = {
      linesCounted: countedLines.length,
      linesSkipped: count.lines.length - countedLines.length,
      variances: variances.length,
      netUnits: variances.reduce((s, l) => s + l.variance, 0),
    };

    onCommit(() => writeAudit({
      action: 'STOCK_COUNT_COMPLETED', module: 'StockCount', recordId: count._id,
      recordLabel: count.countNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: summary,
    }));

    return { id: count._id, summary };
  });

  const count = await getCount(actor, result.id);
  return { count, summary: result.summary };
}

export async function cancelCount(actor, id, reason) {
  const count = await StockCount.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!count) throw new NotFoundError('Stock count not found');
  if (count.status === 'COMPLETED') {
    throw new DomainError('A completed count cannot be cancelled', 'COUNT_COMPLETED');
  }

  count.status = 'CANCELLED';
  count.remarks = reason;
  await count.save();

  await writeAudit({
    action: 'STOCK_COUNT_CANCELLED', module: 'StockCount', recordId: count._id,
    recordLabel: count.countNumber, severity: 'WARNING', tenantId: actor.tenantId,
    metadata: { reason },
  });

  return getCount(actor, count._id);
}

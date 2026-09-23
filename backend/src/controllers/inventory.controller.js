import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { Inventory } from '../models/Inventory.js';
import * as adjustmentService from '../services/inventory/adjustmentService.js';
import * as stockCountService from '../services/inventory/stockCountService.js';
import * as notificationService from '../services/shared/notificationService.js';
import { warehouseScopeFilter } from '../services/shared/scopeService.js';
import { serializeLedgerEntry } from '../serializers/purchase.serializer.js';

export const adjust = asyncHandler(async (req, res) => {
  const entry = await adjustmentService.adjustStock(req.actor, req.body);
  return ok(res, { message: 'Stock adjusted', data: serializeLedgerEntry(entry) });
});

export const reclassify = asyncHandler(async (req, res) => {
  const entry = await adjustmentService.reclassifyStock(req.actor, req.body);
  return ok(res, { message: 'Stock reclassified', data: serializeLedgerEntry(entry) });
});

// ------------------------------------------------------------- stock counts

const serializeCount = (c) => {
  if (!c) return null;
  const d = c.toObject ? c.toObject() : c;
  const lines = (d.lines ?? []).map((l) => ({
    id: String(l._id),
    product: l.product && typeof l.product === 'object'
      ? { id: String(l.product._id), name: l.product.name, sku: l.product.sku, uom: l.product.unitOfMeasure }
      : String(l.product),
    systemQuantity: l.systemQuantity,
    countedQuantity: l.countedQuantity,
    variance: l.variance,
    counted: l.counted,
    remarks: l.remarks ?? null,
  }));

  return {
    id: String(d._id),
    countNumber: d.countNumber,
    warehouse: d.warehouse && typeof d.warehouse === 'object'
      ? { id: String(d.warehouse._id), name: d.warehouse.name, code: d.warehouse.code }
      : String(d.warehouse),
    scope: d.scope,
    status: d.status,
    snapshotAt: d.snapshotAt,
    completedAt: d.completedAt ?? null,
    lines,
    progress: {
      total: lines.length,
      counted: lines.filter((l) => l.counted).length,
      variances: lines.filter((l) => l.counted && l.variance !== 0).length,
    },
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
};

export const listCounts = asyncHandler(async (req, res) => {
  const { items, meta } = await stockCountService.listCounts(req.actor, req.query);
  return ok(res, { data: items.map(serializeCount), meta });
});

export const getCount = asyncHandler(async (req, res) => {
  const count = await stockCountService.getCount(req.actor, req.params.id);
  return ok(res, { data: serializeCount(count) });
});

export const createCount = asyncHandler(async (req, res) => {
  const count = await stockCountService.createCount(req.actor, req.body);
  return created(res, { message: 'Count sheet generated', data: serializeCount(count) });
});

export const recordCounts = asyncHandler(async (req, res) => {
  const count = await stockCountService.recordCounts(req.actor, req.params.id, req.body.entries);
  return ok(res, { message: 'Counts recorded', data: serializeCount(count) });
});

export const completeCount = asyncHandler(async (req, res) => {
  const { count, summary } = await stockCountService.completeCount(req.actor, req.params.id, req.body);
  return ok(res, {
    message: `Count posted — ${summary.variances} variance${summary.variances === 1 ? '' : 's'} adjusted`
      + (summary.linesSkipped > 0 ? `, ${summary.linesSkipped} line(s) left uncounted and untouched` : ''),
    data: { count: serializeCount(count), summary },
  });
});

export const cancelCount = asyncHandler(async (req, res) => {
  const count = await stockCountService.cancelCount(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Count cancelled', data: serializeCount(count) });
});

// ------------------------------------------------------------------ alerts

export const lowStock = asyncHandler(async (req, res) => {
  const match = { tenantId: req.actor.tenantId, ...warehouseScopeFilter(req.actor) };
  if (req.query.warehouse) match.warehouse = req.query.warehouse;

  const rows = await Inventory.aggregate([
    { $match: match },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
    { $unwind: '$product' },
    {
      $match: {
        'product.deletedAt': null,
        'product.status': 'ACTIVE',
        'product.reorderLevel': { $gt: 0 },
        $expr: { $lte: ['$availableQuantity', '$product.reorderLevel'] },
      },
    },
    { $lookup: { from: 'warehouses', localField: 'warehouse', foreignField: '_id', as: 'warehouse' } },
    { $unwind: '$warehouse' },
    { $sort: { availableQuantity: 1 } },
    { $limit: Number(req.query.limit) || 50 },
  ]);

  return ok(res, {
    data: rows.map((r) => ({
      id: String(r._id),
      product: { id: String(r.product._id), name: r.product.name, sku: r.product.sku },
      warehouse: { id: String(r.warehouse._id), name: r.warehouse.name, code: r.warehouse.code },
      available: r.availableQuantity,
      reorderLevel: r.product.reorderLevel,
      // What to actually order — the number the buyer needs, not a hint.
      suggestedOrder: Math.max(
        r.product.reorderQuantity ?? 0,
        (r.product.maxStockLevel ?? 0) - r.availableQuantity,
      ),
      outOfStock: r.availableQuantity === 0,
    })),
    meta: { total: rows.length },
  });
});

export const listNotifications = asyncHandler(async (req, res) => {
  const { items, meta } = await notificationService.listNotifications(req.actor, {
    unreadOnly: req.query.unreadOnly === true,
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 25,
  });
  return ok(res, {
    data: items.map((n) => ({
      id: String(n._id),
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      severity: n.severity,
      actionUrl: n.actionUrl ?? null,
      readAt: n.readAt ?? null,
      createdAt: n.createdAt,
    })),
    meta,
  });
});

export const readNotification = asyncHandler(async (req, res) => {
  await notificationService.markRead(req.actor, req.params.id);
  return ok(res, { message: 'Marked as read' });
});

export const readAllNotifications = asyncHandler(async (req, res) => {
  const count = await notificationService.markAllRead(req.actor);
  return ok(res, { message: `${count} marked as read` });
});

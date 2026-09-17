import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as poService from '../services/purchase/poService.js';
import * as grnService from '../services/purchase/grnService.js';
import { Inventory } from '../models/Inventory.js';
import { InventoryTransaction } from '../models/InventoryTransaction.js';
import { reconcile } from '../services/inventory/ledgerService.js';
import { warehouseScopeFilter } from '../services/shared/scopeService.js';
import {
  serializePurchaseOrder, serializeGrn, serializeInventory, serializeLedgerEntry,
} from '../serializers/purchase.serializer.js';

// ------------------------------------------------------------ purchase orders

export const listPos = asyncHandler(async (req, res) => {
  const { items, meta } = await poService.listPurchaseOrders(req.actor, req.query);
  return ok(res, { data: items.map(serializePurchaseOrder), meta });
});

export const getPo = asyncHandler(async (req, res) => {
  const po = await poService.getPurchaseOrder(req.actor, req.params.id);
  return ok(res, { data: serializePurchaseOrder(po) });
});

export const createPo = asyncHandler(async (req, res) => {
  const po = await poService.createPurchaseOrder(req.actor, req.body);
  return created(res, { message: 'Purchase order created', data: serializePurchaseOrder(po) });
});

export const updatePo = asyncHandler(async (req, res) => {
  const po = await poService.updatePurchaseOrder(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Purchase order updated', data: serializePurchaseOrder(po) });
});

export const approvePo = asyncHandler(async (req, res) => {
  const po = await poService.approvePurchaseOrder(req.actor, req.params.id);
  return ok(res, { message: 'Purchase order approved', data: serializePurchaseOrder(po) });
});

export const cancelPo = asyncHandler(async (req, res) => {
  const po = await poService.cancelPurchaseOrder(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Purchase order cancelled', data: serializePurchaseOrder(po) });
});

export const shortClosePo = asyncHandler(async (req, res) => {
  const po = await poService.shortClosePurchaseOrder(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Purchase order short-closed', data: serializePurchaseOrder(po) });
});

// ------------------------------------------------------------------------ GRN

export const listGrns = asyncHandler(async (req, res) => {
  const { items, meta } = await grnService.listGrns(req.actor, req.query);
  return ok(res, { data: items.map(serializeGrn), meta });
});

export const getGrn = asyncHandler(async (req, res) => {
  const grn = await grnService.getGrn(req.actor, req.params.id);
  return ok(res, { data: serializeGrn(grn) });
});

export const createGrn = asyncHandler(async (req, res) => {
  const grn = await grnService.createGrn(req.actor, req.body);
  return created(res, { message: 'GRN created as draft — post it to move stock', data: serializeGrn(grn) });
});

export const postGrn = asyncHandler(async (req, res) => {
  const grn = await grnService.postGrn(req.actor, req.params.id);
  return ok(res, { message: 'GRN posted — inventory updated', data: serializeGrn(grn) });
});

export const cancelGrn = asyncHandler(async (req, res) => {
  const grn = await grnService.cancelGrn(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'GRN cancelled — reversing entries posted', data: serializeGrn(grn) });
});

// ------------------------------------------------------------------ inventory

export const listInventory = asyncHandler(async (req, res) => {
  const filter = { tenantId: req.actor.tenantId, ...warehouseScopeFilter(req.actor) };
  if (req.query.product) filter.product = req.query.product;
  if (req.query.warehouse) filter.warehouse = req.query.warehouse;
  if (req.query.inStock === true) filter.availableQuantity = { $gt: 0 };

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 25);

  const [items, total] = await Promise.all([
    Inventory.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('product', 'name sku unitOfMeasure productType')
      .populate('warehouse', 'name code'),
    Inventory.countDocuments(filter),
  ]);

  return ok(res, {
    data: items.map(serializeInventory),
    meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

export const listTransactions = asyncHandler(async (req, res) => {
  const filter = { tenantId: req.actor.tenantId, ...warehouseScopeFilter(req.actor) };
  if (req.query.product) filter.product = req.query.product;
  if (req.query.warehouse) filter.warehouse = req.query.warehouse;
  if (req.query.transactionType) filter.transactionType = req.query.transactionType;
  if (req.query.referenceId) filter.referenceId = req.query.referenceId;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);

  const [items, total] = await Promise.all([
    InventoryTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('performedBy', 'fullName'),
    InventoryTransaction.countDocuments(filter),
  ]);

  return ok(res, {
    data: items.map(serializeLedgerEntry),
    meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

export const runReconciliation = asyncHandler(async (req, res) => {
  const result = await reconcile(req.actor.tenantId, {});
  return ok(res, {
    message: result.drift.length === 0
      ? `Reconciled ${result.checked} locations — no drift.`
      : `Reconciled ${result.checked} locations — ${result.drift.length} show drift and need investigation.`,
    data: result,
  });
});

import { PurchaseOrder } from '../../models/PurchaseOrder.js';
import { Product } from '../../models/Product.js';
import { Vendor } from '../../models/Vendor.js';
import { Warehouse } from '../../models/Warehouse.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit, diff } from '../shared/auditService.js';
import { assertWarehouseInScope, warehouseScopeFilter } from '../shared/scopeService.js';
import { NotFoundError, DomainError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

/** Editable only before approval — an approved PO has been sent to a vendor. */
const EDITABLE_STATUSES = ['DRAFT', 'PENDING_APPROVAL'];

export async function listPurchaseOrders(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null, ...warehouseScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.vendor) filter.vendor = query.vendor;
  if (query.search) filter.poNumber = { $regex: String(query.search).toUpperCase(), $options: 'i' };
  if (query.pendingReceipt) filter.status = { $in: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] };

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    PurchaseOrder.find(filter)
      .sort(parseSort(query.sort, { orderDate: -1 }))
      .skip((page - 1) * limit).limit(limit)
      .populate('vendor', 'vendorName vendorCode leadTimeDays')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku unitOfMeasure'),
    PurchaseOrder.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getPurchaseOrder(actor, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('vendor', 'vendorName vendorCode leadTimeDays')
    .populate('warehouse', 'name code')
    .populate('lines.product', 'name sku unitOfMeasure productType')
    .populate('requestedBy approvedBy', 'fullName');

  if (!po) throw new NotFoundError('Purchase order not found');
  assertWarehouseInScope(actor, po.warehouse?._id ?? po.warehouse);
  return po;
}

export async function createPurchaseOrder(actor, payload) {
  assertWarehouseInScope(actor, payload.warehouse);

  const [vendor, warehouse] = await Promise.all([
    Vendor.findOne({ _id: payload.vendor, tenantId: actor.tenantId, deletedAt: null }),
    Warehouse.findOne({ _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null }),
  ]);

  if (!vendor) throw new NotFoundError('Vendor not found');
  if (vendor.status !== 'ACTIVE') {
    throw new DomainError(`${vendor.vendorName} is ${vendor.status.toLowerCase()} and cannot be ordered from`, 'VENDOR_NOT_ACTIVE');
  }
  if (!warehouse) throw new NotFoundError('Warehouse not found');
  if (warehouse.isSystem) {
    throw new DomainError('A purchase order cannot be raised against a system warehouse', 'SYSTEM_WAREHOUSE');
  }

  await assertProductsUsable(actor, payload.lines);

  // One line per product. Two lines for the same product make receipt
  // reconciliation ambiguous — which line does an incoming quantity settle?
  const productIds = payload.lines.map((l) => String(l.product));
  if (new Set(productIds).size !== productIds.length) {
    throw new DomainError('Each product may appear only once on a purchase order', 'DUPLICATE_PO_LINE');
  }

  const poNumber = await nextDocumentNumber('PO');

  const po = await PurchaseOrder.create({
    tenantId: actor.tenantId,
    poNumber,
    vendor: payload.vendor,
    warehouse: payload.warehouse,
    orderDate: payload.orderDate ?? new Date(),
    expectedDeliveryDate: payload.expectedDeliveryDate ?? null,
    lines: payload.lines,
    status: 'DRAFT',
    requestedBy: actor.id,
    remarks: payload.remarks ?? null,
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'PURCHASE_ORDER_CREATED', module: 'PurchaseOrder', recordId: po._id,
    recordLabel: po.poNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getPurchaseOrder(actor, po._id);
}

async function assertProductsUsable(actor, lines) {
  const products = await Product.find({
    _id: { $in: lines.map((l) => l.product) }, tenantId: actor.tenantId, deletedAt: null,
  });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  for (const line of lines) {
    const product = byId.get(String(line.product));
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);
    if (product.status === 'DISCONTINUED') {
      throw new DomainError(`${product.name} is discontinued and cannot be ordered`, 'PRODUCT_DISCONTINUED');
    }
  }
}

export async function updatePurchaseOrder(actor, id, payload) {
  const po = await PurchaseOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!po) throw new NotFoundError('Purchase order not found');
  assertWarehouseInScope(actor, po.warehouse);

  if (!EDITABLE_STATUSES.includes(po.status)) {
    throw new DomainError(
      `A ${po.status.toLowerCase().replace('_', ' ')} purchase order can no longer be edited`,
      'PO_NOT_EDITABLE',
    );
  }

  if (payload.lines) await assertProductsUsable(actor, payload.lines);

  const before = po.toObject();
  Object.assign(po, payload);
  po.updatedBy = actor.id;
  await po.save();

  await writeAudit({
    action: 'PURCHASE_ORDER_UPDATED', module: 'PurchaseOrder', recordId: po._id,
    recordLabel: po.poNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    changes: diff(before, po.toObject(), ['vendor', 'warehouse', 'expectedDeliveryDate', 'lines', 'remarks']),
  });

  return getPurchaseOrder(actor, po._id);
}

export async function approvePurchaseOrder(actor, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!po) throw new NotFoundError('Purchase order not found');

  if (!EDITABLE_STATUSES.includes(po.status)) {
    throw new DomainError('Only a draft or pending purchase order can be approved', 'PO_NOT_APPROVABLE');
  }

  // The requester approving their own order defeats the control entirely.
  if (String(po.requestedBy) === String(actor.id) && !actor.can('MANAGE_SUPER_ADMIN')) {
    throw new DomainError(
      'A purchase order must be approved by someone other than the person who raised it',
      'SELF_APPROVAL_BLOCKED',
    );
  }

  po.status = 'APPROVED';
  po.approvedBy = actor.id;
  po.approvedAt = new Date();
  await po.save();

  await writeAudit({
    action: 'PURCHASE_ORDER_APPROVED', module: 'PurchaseOrder', recordId: po._id,
    recordLabel: po.poNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
  });

  return getPurchaseOrder(actor, po._id);
}

export async function cancelPurchaseOrder(actor, id, reason) {
  const po = await PurchaseOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!po) throw new NotFoundError('Purchase order not found');

  const received = po.lines.reduce((sum, l) => sum + l.receivedQuantity, 0);
  if (received > 0) {
    throw new DomainError(
      'Goods have already been received against this order. Short-close it instead of cancelling.',
      'PO_PARTIALLY_RECEIVED',
    );
  }

  po.status = 'CANCELLED';
  po.closedReason = reason;
  po.updatedBy = actor.id;
  await po.save();

  await writeAudit({
    action: 'PURCHASE_ORDER_CANCELLED', module: 'PurchaseOrder', recordId: po._id,
    recordLabel: po.poNumber, severity: 'WARNING', tenantId: actor.tenantId, metadata: { reason },
  });

  return getPurchaseOrder(actor, po._id);
}

/**
 * Short-close: the vendor cannot supply the balance.
 *
 * Records the shortfall honestly rather than marking the order complete. The
 * alternative — quietly setting it to RECEIVED — makes the outstanding-order
 * report lie, and vendor supply performance unmeasurable.
 */
export async function shortClosePurchaseOrder(actor, id, reason) {
  const po = await PurchaseOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!po) throw new NotFoundError('Purchase order not found');

  if (!['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
    throw new DomainError('Only an open purchase order can be short-closed', 'PO_NOT_OPEN');
  }

  let shortfall = 0;
  for (const line of po.lines) {
    const settled = line.receivedQuantity + line.rejectedQuantity + line.shortClosedQuantity;
    const outstanding = Math.max(0, line.orderedQuantity - settled);
    line.shortClosedQuantity += outstanding;
    shortfall += outstanding;
  }

  po.status = 'SHORT_CLOSED';
  po.closedReason = reason;
  po.updatedBy = actor.id;
  await po.save();

  await writeAudit({
    action: 'PURCHASE_ORDER_SHORT_CLOSED', module: 'PurchaseOrder', recordId: po._id,
    recordLabel: po.poNumber, severity: 'WARNING', tenantId: actor.tenantId,
    metadata: { reason, shortfall },
  });

  return getPurchaseOrder(actor, po._id);
}

import { SalesOrder } from '../../models/SalesOrder.js';
import { Customer } from '../../models/Customer.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { moveBetweenBuckets } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { assertWarehouseInScope, warehouseScopeFilter } from '../shared/scopeService.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

export async function listSalesOrders(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null, ...warehouseScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.customer) filter.customer = query.customer;
  if (query.search) filter.salesOrderNumber = { $regex: String(query.search).toUpperCase(), $options: 'i' };

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    SalesOrder.find(filter).sort(parseSort(query.sort, { orderDate: -1 }))
      .skip((page - 1) * limit).limit(limit)
      .populate('customer', 'customerName customerCode customerType')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku productType unitOfMeasure'),
    SalesOrder.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getSalesOrder(actor, id) {
  const order = await SalesOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('customer', 'customerName customerCode customerType')
    .populate('warehouse', 'name code')
    .populate('lines.product', 'name sku productType unitOfMeasure warrantyMonths')
    .populate('confirmedBy createdBy', 'fullName');

  if (!order) throw new NotFoundError('Sales order not found');
  assertWarehouseInScope(actor, order.warehouse?._id ?? order.warehouse);
  return order;
}

export async function createSalesOrder(actor, payload) {
  assertWarehouseInScope(actor, payload.warehouse);

  const [customer, warehouse] = await Promise.all([
    Customer.findOne({ _id: payload.customer, tenantId: actor.tenantId, deletedAt: null }),
    Warehouse.findOne({ _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null }),
  ]);

  if (!customer) throw new NotFoundError('Customer not found');
  if (customer.status === 'ON_HOLD') {
    throw new DomainError(`${customer.customerName} is on hold and cannot be ordered for`, 'CUSTOMER_ON_HOLD');
  }
  if (customer.status !== 'ACTIVE') {
    throw new DomainError(`${customer.customerName} is not active`, 'CUSTOMER_NOT_ACTIVE');
  }
  if (!warehouse) throw new NotFoundError('Warehouse not found');
  if (warehouse.isSystem) {
    throw new DomainError('Goods cannot be sold from a system warehouse', 'SYSTEM_WAREHOUSE');
  }

  const productIds = payload.lines.map((l) => String(l.product));
  if (new Set(productIds).size !== productIds.length) {
    throw new DomainError('Each product may appear only once on a sales order', 'DUPLICATE_ORDER_LINE');
  }

  const products = await Product.find({
    _id: { $in: productIds }, tenantId: actor.tenantId, deletedAt: null,
  });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  for (const line of payload.lines) {
    const product = byId.get(String(line.product));
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);
    if (product.status === 'DISCONTINUED') {
      throw new DomainError(`${product.name} is discontinued and cannot be sold`, 'PRODUCT_DISCONTINUED');
    }
  }

  const salesOrderNumber = await nextDocumentNumber('SO');

  const order = await SalesOrder.create({
    tenantId: actor.tenantId,
    salesOrderNumber,
    customer: payload.customer,
    customerPoReference: payload.customerPoReference ?? null,
    warehouse: payload.warehouse,
    orderDate: payload.orderDate ?? new Date(),
    requiredByDate: payload.requiredByDate ?? null,
    projectReference: payload.projectReference ?? null,
    lines: payload.lines.map((l) => ({
      product: l.product,
      orderedQuantity: l.orderedQuantity,
      remarks: l.remarks ?? null,
    })),
    status: 'DRAFT',
    remarks: payload.remarks ?? null,
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'SALES_ORDER_CREATED', module: 'SalesOrder', recordId: order._id,
    recordLabel: order.salesOrderNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getSalesOrder(actor, order._id);
}

/**
 * CONFIRM — the reservation step, and the heart of the sales flow.
 *
 * Stock moves AVAILABLE → RESERVED. Nothing physically leaves, but the units
 * are now claimed: another order confirmed a second later finds less available
 * and is refused.
 *
 * This is why `AVAILABLE → DISPATCHED` is not a legal serial transition. The
 * reservation is an atomic claim on specific units, and claiming is what makes
 * "a serial cannot be dispatched twice" a database guarantee rather than a
 * hope. Two confirmations racing for the same serial both try to write that
 * document; MongoDB aborts one, the retry sees RESERVED, and the table refuses
 * RESERVED → RESERVED.
 */
export async function confirmSalesOrder(actor, id, { serialSelections = [] } = {}) {
  const orderId = await withTransaction(async ({ session, onCommit }) => {
    const order = await SalesOrder.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!order) throw new NotFoundError('Sales order not found');
    assertWarehouseInScope(actor, order.warehouse);

    if (order.status !== 'DRAFT') {
      throw new ConflictError(
        order.status === 'CONFIRMED' ? 'This order is already confirmed' : `A ${order.status.toLowerCase()} order cannot be confirmed`,
        'ORDER_NOT_CONFIRMABLE',
      );
    }

    const products = await Product.find({
      _id: { $in: order.lines.map((l) => l.product) }, tenantId: actor.tenantId,
    }).session(session);
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const selectionByLine = new Map(
      serialSelections.map((s) => [String(s.lineId), (s.serialNumbers ?? []).map((n) => n.toUpperCase())]),
    );

    for (const line of order.lines) {
      const product = byId.get(String(line.product));
      const quantity = line.orderedQuantity;

      // Guarded: fails with INSUFFICIENT_STOCK if availability dropped since
      // the order was raised.
      await moveBetweenBuckets({
        session, actor,
        product: line.product,
        warehouse: order.warehouse,
        fromBucket: 'AVAILABLE',
        toBucket: 'RESERVED',
        quantity,
        transactionType: 'RESERVATION',
        referenceType: 'DISPATCH_NOTE',
        referenceId: order._id,
        referenceNumber: order.salesOrderNumber,
        remarks: 'Reserved for sales order',
      });

      if (product.productType === 'SERIALIZED') {
        const chosen = selectionByLine.get(String(line._id)) ?? [];
        const serials = chosen.length > 0
          ? await claimNamedSerials(actor, session, order, line, chosen)
          : await claimAnyAvailableSerials(actor, session, order, line, quantity);

        if (serials.length !== quantity) {
          throw new DomainError(
            `${product.name}: ${quantity} required but only ${serials.length} units could be reserved`,
            'INSUFFICIENT_SERIALS',
          );
        }
        line.reservedSerialNumbers = serials.map((s) => s.serialNumber);
      }

      line.reservedQuantity = quantity;
    }

    order.status = 'CONFIRMED';
    order.confirmedBy = actor.id;
    order.confirmedAt = new Date();
    await order.save({ session });

    onCommit(() => writeAudit({
      action: 'SALES_ORDER_CONFIRMED', module: 'SalesOrder', recordId: order._id,
      recordLabel: order.salesOrderNumber, severity: 'NOTICE', tenantId: actor.tenantId,
      metadata: { reserved: order.lines.reduce((s, l) => s + l.reservedQuantity, 0) },
    }));

    return order._id;
  });

  return getSalesOrder(actor, orderId);
}

/** Reserves specific serials the salesperson picked. */
async function claimNamedSerials(actor, session, order, line, serialNumbers) {
  const serials = await SerialNumber.find({
    tenantId: actor.tenantId,
    serialNumber: { $in: serialNumbers },
    product: line.product,
  }).session(session);

  const found = new Set(serials.map((s) => s.serialNumber));
  const missing = serialNumbers.filter((s) => !found.has(s));
  if (missing.length) {
    throw new DomainError(
      `Not found for this product: ${missing.join(', ')}`,
      'SERIAL_NOT_FOUND',
      missing.map((s) => ({ code: 'SERIAL_NOT_FOUND', serialNumber: s })),
    );
  }

  for (const serial of serials) {
    if (String(serial.warehouse) !== String(order.warehouse)) {
      throw new DomainError(
        `${serial.serialNumber} is not at the warehouse this order ships from`,
        'SERIAL_WRONG_WAREHOUSE',
      );
    }
    await serialService.transition({
      session, actor, serial, toStatus: 'RESERVED', eventType: 'ORDER_RESERVED',
      referenceType: 'DISPATCH_NOTE', referenceId: order._id,
      referenceNumber: order.salesOrderNumber,
    });
  }

  return serials;
}

/**
 * Reserves any available units, oldest first.
 *
 * Oldest-first is deliberate: it keeps stock rotating, so the unit that has sat
 * on the shelf longest is the one that ships, and warranty periods are not
 * quietly consumed in the warehouse.
 */
async function claimAnyAvailableSerials(actor, session, order, line, quantity) {
  const candidates = await SerialNumber.find({
    tenantId: actor.tenantId,
    product: line.product,
    warehouse: order.warehouse,
    status: 'AVAILABLE',
  }).sort({ receivedDate: 1, createdAt: 1 }).limit(quantity).session(session);

  for (const serial of candidates) {
    await serialService.transition({
      session, actor, serial, toStatus: 'RESERVED', eventType: 'ORDER_RESERVED',
      referenceType: 'DISPATCH_NOTE', referenceId: order._id,
      referenceNumber: order.salesOrderNumber,
    });
  }

  return candidates;
}

/**
 * Releases the reservation and returns stock to available.
 *
 * Reservations are never released automatically on a timer. Silently
 * un-reserving stock a salesperson is negotiating around causes worse problems
 * than a stale reservation; Phase 11 reports them, a human releases them.
 */
export async function releaseReservation(actor, id, reason) {
  const orderId = await withTransaction(async ({ session, onCommit }) => {
    const order = await SalesOrder.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!order) throw new NotFoundError('Sales order not found');
    assertWarehouseInScope(actor, order.warehouse);

    if (!['CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(order.status)) {
      throw new DomainError('This order holds no reservation to release', 'NO_RESERVATION');
    }

    for (const line of order.lines) {
      const toRelease = line.reservedQuantity - line.dispatchedQuantity;
      if (toRelease <= 0) continue;

      await moveBetweenBuckets({
        session, actor,
        product: line.product, warehouse: order.warehouse,
        fromBucket: 'RESERVED', toBucket: 'AVAILABLE', quantity: toRelease,
        transactionType: 'RESERVATION_RELEASE',
        referenceType: 'DISPATCH_NOTE',
        referenceId: order._id, referenceNumber: order.salesOrderNumber,
        remarks: reason,
      });

      const stillHeld = line.reservedSerialNumbers.filter(Boolean);
      if (stillHeld.length) {
        const serials = await SerialNumber.find({
          tenantId: actor.tenantId, serialNumber: { $in: stillHeld }, status: 'RESERVED',
        }).session(session);

        for (const serial of serials) {
          await serialService.transition({
            session, actor, serial, toStatus: 'AVAILABLE', eventType: 'RESERVATION_RELEASED',
            referenceType: 'DISPATCH_NOTE', referenceId: order._id,
            referenceNumber: order.salesOrderNumber, remarks: reason,
          });
        }
        line.reservedSerialNumbers = [];
      }

      line.reservedQuantity = line.dispatchedQuantity;
      line.cancelledQuantity += toRelease;
    }

    order.status = order.lines.some((l) => l.dispatchedQuantity > 0) ? 'CLOSED' : 'CANCELLED';
    order.cancelReason = reason;
    order.cancelledBy = actor.id;
    await order.save({ session });

    onCommit(() => writeAudit({
      action: 'SALES_ORDER_RESERVATION_RELEASED', module: 'SalesOrder', recordId: order._id,
      recordLabel: order.salesOrderNumber, severity: 'WARNING', tenantId: actor.tenantId,
      metadata: { reason },
    }));

    return order._id;
  });

  return getSalesOrder(actor, orderId);
}

export async function cancelSalesOrder(actor, id, reason) {
  const order = await SalesOrder.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!order) throw new NotFoundError('Sales order not found');
  assertWarehouseInScope(actor, order.warehouse);

  // A confirmed order holds stock, so cancelling it must release that stock —
  // which is exactly what releaseReservation does, inside a transaction.
  if (['CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(order.status)) {
    return releaseReservation(actor, id, reason);
  }

  if (order.status !== 'DRAFT') {
    throw new DomainError(`A ${order.status.toLowerCase()} order cannot be cancelled`, 'ORDER_NOT_CANCELLABLE');
  }

  order.status = 'CANCELLED';
  order.cancelReason = reason;
  order.cancelledBy = actor.id;
  await order.save();

  await writeAudit({
    action: 'SALES_ORDER_CANCELLED', module: 'SalesOrder', recordId: order._id,
    recordLabel: order.salesOrderNumber, severity: 'WARNING', tenantId: actor.tenantId,
    metadata: { reason },
  });

  return getSalesOrder(actor, order._id);
}

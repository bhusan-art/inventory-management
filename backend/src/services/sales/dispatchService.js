import { DispatchNote } from '../../models/DispatchNote.js';
import { SalesOrder } from '../../models/SalesOrder.js';
import { Warranty } from '../../models/Warranty.js';
import { Customer } from '../../models/Customer.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { assertWarehouseInScope, warehouseScopeFilter } from '../shared/scopeService.js';
import { addMonths } from '../../utils/dates.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

export async function listDispatchNotes(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null, ...warehouseScopeFilter(actor) };
  if (query.status) filter.status = query.status;
  if (query.customer) filter.customer = query.customer;
  if (query.search) filter.dispatchNoteNumber = { $regex: String(query.search).toUpperCase(), $options: 'i' };

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    DispatchNote.find(filter).sort({ dispatchDate: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('customer', 'customerName customerCode')
      .populate('warehouse', 'name code')
      .populate('salesOrder', 'salesOrderNumber')
      .populate('lines.product', 'name sku productType'),
    DispatchNote.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getDispatchNote(actor, id) {
  const note = await DispatchNote.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('customer', 'customerName customerCode')
    .populate('warehouse', 'name code')
    .populate('salesOrder', 'salesOrderNumber status')
    .populate('lines.product', 'name sku productType warrantyMonths')
    .populate('createdBy', 'fullName');

  if (!note) throw new NotFoundError('Dispatch note not found');
  assertWarehouseInScope(actor, note.warehouse?._id ?? note.warehouse);
  return note;
}

/**
 * DISPATCH — goods leave for the customer. One transaction.
 *
 *   1. re-validate the reservation is still held by this order
 *   2. reserved −q  (available is untouched: it was decremented at confirm)
 *   3. ledger: DISPATCH rows, direction OUT
 *   4. serials RESERVED → DISPATCHED, customer and dispatch date recorded
 *   5. a warranty per serialized unit, dates computed
 *   6. sales order tallies updated, status derived
 *
 * Step 2 is the subtle one. A dispatch does NOT decrement `available` —
 * confirming already did that. Decrementing again would remove the stock
 * twice, and the second decrement would eventually fail against a warehouse
 * that visibly holds the goods.
 */
export async function createDispatch(actor, payload, { idempotencyKey } = {}) {
  if (idempotencyKey) {
    const existing = await DispatchNote.findOne({ tenantId: actor.tenantId, idempotencyKey });
    // A retried request returns the original note rather than shipping twice.
    if (existing) return getDispatchNote(actor, existing._id);
  }

  const noteId = await withTransaction(async ({ session, onCommit }) => {
    const [customer, warehouse] = await Promise.all([
      Customer.findOne({ _id: payload.customer, tenantId: actor.tenantId, deletedAt: null }).session(session),
      Warehouse.findOne({ _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null }).session(session),
    ]);
    if (!customer) throw new NotFoundError('Customer not found');
    if (!warehouse) throw new NotFoundError('Warehouse not found');
    assertWarehouseInScope(actor, warehouse._id);

    let order = null;
    if (payload.salesOrder) {
      order = await SalesOrder.findOne({
        _id: payload.salesOrder, tenantId: actor.tenantId, deletedAt: null,
      }).session(session);
      if (!order) throw new NotFoundError('Sales order not found');
      if (!['CONFIRMED', 'PARTIALLY_DISPATCHED'].includes(order.status)) {
        throw new DomainError(
          `Goods cannot be dispatched against a ${order.status.toLowerCase().replace('_', ' ')} order`,
          'ORDER_NOT_DISPATCHABLE',
        );
      }
      if (String(order.customer) !== String(payload.customer)) {
        throw new DomainError('This order belongs to a different customer', 'ORDER_CUSTOMER_MISMATCH');
      }
    }

    const products = await Product.find({
      _id: { $in: payload.lines.map((l) => l.product) }, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const dispatchDate = payload.dispatchDate ? new Date(payload.dispatchDate) : new Date();
    // `{ session }` is not optional here. Without it this upsert runs OUTSIDE
    // the transaction it sits inside, and two things go wrong.
    //
    // It writes the `counters` collection non-transactionally; the transaction
    // then upserts the TXN counter in that same collection through
    // ledgerService, at a snapshot taken before this insert committed. The
    // transactional write conflicts, gets labelled TransientTransactionError,
    // and the retry repeats the whole thing — three attempts, then a 409.
    // Dispatch was the only endpoint mixing a sessioned and an un-sessioned
    // counter write in one transaction, which is why it was the only one
    // failing.
    //
    // And the number itself leaked: an un-sessioned `$inc` is not rolled back
    // when the transaction aborts, so every retry burned a dispatch note
    // number. A sequence with silent gaps is not much of an audit trail.
    const dispatchNoteNumber = await nextDocumentNumber('DN', { session });
    const preparedLines = [];
    const warrantiesToCreate = [];

    for (const line of payload.lines) {
      const product = byId.get(String(line.product));
      if (!product) throw new NotFoundError(`Product ${line.product} not found`);

      const serials = (line.serialNumbers ?? []).map((s) => String(s).trim().toUpperCase());

      if (product.productType === 'SERIALIZED' && serials.length !== line.quantity) {
        throw new DomainError(
          `${product.name}: dispatching ${line.quantity} requires ${line.quantity} serial numbers, ${serials.length} given`,
          'SERIAL_COUNT_MISMATCH',
        );
      }
      if (product.productType !== 'SERIALIZED' && serials.length > 0) {
        throw new DomainError(`${product.name} is not serialized`, 'SERIALS_NOT_APPLICABLE');
      }

      let orderLine = null;
      if (order) {
        orderLine = line.salesOrderLineId
          ? order.lines.id(line.salesOrderLineId)
          : order.lines.find((l) => String(l.product) === String(line.product));
        if (!orderLine) {
          throw new DomainError(`${product.name} is not on order ${order.salesOrderNumber}`, 'PRODUCT_NOT_ON_ORDER');
        }

        const outstanding = order.outstandingFor(orderLine);
        if (line.quantity > outstanding) {
          throw new DomainError(
            `${product.name}: ${outstanding} outstanding on ${order.salesOrderNumber}, but ${line.quantity} dispatched`,
            'OVER_DISPATCH_EXCEEDED',
          );
        }
      }

      // Reserved stock leaves. `available` is untouched — confirm moved it.
      await applyMovement({
        session, actor,
        product: line.product,
        warehouse: warehouse._id,
        bucket: order ? 'RESERVED' : 'AVAILABLE',
        quantityChange: -line.quantity,
        transactionType: 'DISPATCH',
        referenceType: 'DISPATCH_NOTE',
        referenceNumber: dispatchNoteNumber,
        remarks: `Dispatched to ${customer.customerName}`,
      });

      if (serials.length > 0) {
        const serialDocs = await SerialNumber.find({
          tenantId: actor.tenantId, serialNumber: { $in: serials },
        }).session(session);

        if (serialDocs.length !== serials.length) {
          const found = new Set(serialDocs.map((s) => s.serialNumber));
          throw new NotFoundError(
            `Unknown serial numbers: ${serials.filter((s) => !found.has(s)).join(', ')}`,
            'SERIAL_NOT_FOUND',
          );
        }

        for (const serial of serialDocs) {
          if (order && !orderLine.reservedSerialNumbers.includes(serial.serialNumber)) {
            throw new DomainError(
              `${serial.serialNumber} is not reserved for order ${order.salesOrderNumber}`,
              'SERIAL_NOT_RESERVED_FOR_ORDER',
            );
          }

          // RESERVED → DISPATCHED. The table forbids anything else arriving
          // here, so a unit already dispatched cannot be dispatched again.
          await serialService.transition({
            session, actor, serial, toStatus: 'DISPATCHED', eventType: 'DISPATCHED_TO_CUSTOMER',
            referenceType: 'DISPATCH_NOTE', referenceNumber: dispatchNoteNumber,
            warehouse: null, customer: customer._id,
            extra: { dispatchDate },
          });

          if (product.warrantyMonths > 0) {
            warrantiesToCreate.push({ serial, product, customer });
          }
        }
      }

      preparedLines.push({
        product: line.product,
        salesOrderLineId: orderLine?._id ?? null,
        quantity: line.quantity,
        serialNumbers: serials,
        remarks: line.remarks ?? null,
      });

      if (orderLine) {
        orderLine.dispatchedQuantity += line.quantity;
      }
    }

    const [note] = await DispatchNote.create([{
      tenantId: actor.tenantId,
      dispatchNoteNumber,
      salesOrder: order?._id ?? null,
      customer: customer._id,
      warehouse: warehouse._id,
      dispatchDate,
      shippingAddress: payload.shippingAddress ?? customer.billingAddress ?? undefined,
      vehicleNumber: payload.vehicleNumber ?? null,
      transporter: payload.transporter ?? null,
      lrNumber: payload.lrNumber ?? null,
      lines: preparedLines,
      idempotencyKey: idempotencyKey ?? null,
      remarks: payload.remarks ?? null,
      status: 'DISPATCHED',
      createdBy: actor.id,
    }], { session, ordered: true });

    // Warranty starts on dispatch, not on order date: cover begins when the
    // customer has the goods.
    for (const item of warrantiesToCreate) {
      const warrantyNumber = await nextDocumentNumber('WTY', { session });
      const [warranty] = await Warranty.create([{
        tenantId: actor.tenantId,
        warrantyNumber,
        product: item.product._id,
        serialNumber: item.serial._id,
        customer: item.customer._id,
        dispatchNote: note._id,
        dispatchDate,
        startDate: dispatchDate,
        endDate: addMonths(dispatchDate, item.product.warrantyMonths),
        durationMonths: item.product.warrantyMonths,
        provider: 'MANUFACTURER',
        state: 'ACTIVE',
        createdBy: actor.id,
      }], { session, ordered: true });

      item.serial.currentWarranty = warranty._id;
      item.serial.dispatchNote = note._id;
      await item.serial.save({ session });
    }

    if (order) {
      order.recalculateStatus();
      await order.save({ session });
    }

    onCommit(() => notify({
      tenantId: actor.tenantId,
      type: 'DISPATCH_AWAITING_DELIVERY',
      title: `${note.dispatchNoteNumber} dispatched to ${customer.customerName}`,
      body: 'Stock has left the warehouse. Record the delivery once it is signed for.',
      severity: 'NOTICE',
      recipientPermission: 'CREATE_DISPATCH',
      module: 'DispatchNote',
      recordId: note._id,
      actionUrl: `/dispatch-notes/${note._id}`,
      dedupeKey: `DISPATCH_SENT:${note._id}`,
    }));

    onCommit(() => writeAudit({
      action: 'GOODS_DISPATCHED', module: 'DispatchNote', recordId: note._id,
      recordLabel: note.dispatchNoteNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        customer: customer.customerCode,
        units: preparedLines.reduce((s, l) => s + l.quantity, 0),
        serials: preparedLines.reduce((s, l) => s + l.serialNumbers.length, 0),
        warranties: warrantiesToCreate.length,
      },
    }));

    return note._id;
  });

  return getDispatchNote(actor, noteId);
}

export async function markDelivered(actor, id, { deliveredDate, receivedByName }) {
  const note = await DispatchNote.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!note) throw new NotFoundError('Dispatch note not found');
  assertWarehouseInScope(actor, note.warehouse);

  if (note.status !== 'DISPATCHED') {
    throw new DomainError(`A ${note.status.toLowerCase()} dispatch cannot be marked delivered`, 'NOT_IN_TRANSIT');
  }

  note.status = 'DELIVERED';
  note.deliveredDate = deliveredDate ?? new Date();
  note.receivedByName = receivedByName ?? null;
  await note.save();

  await writeAudit({
    action: 'DISPATCH_DELIVERED', module: 'DispatchNote', recordId: note._id,
    recordLabel: note.dispatchNoteNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getDispatchNote(actor, note._id);
}

/**
 * Cancels a dispatch that never actually left.
 *
 * Refused once delivered — at that point the goods are with the customer and
 * the honest route is a customer return, which Phase 9 provides. Pretending
 * the dispatch never happened would orphan the warranty and leave the customer
 * holding units the system says it still owns.
 */
export async function cancelDispatch(actor, id, reason) {
  const noteId = await withTransaction(async ({ session, onCommit }) => {
    const note = await DispatchNote.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!note) throw new NotFoundError('Dispatch note not found');
    assertWarehouseInScope(actor, note.warehouse);

    if (note.status === 'CANCELLED') {
      throw new ConflictError('This dispatch is already cancelled', 'ALREADY_CANCELLED');
    }
    if (note.status !== 'DISPATCHED') {
      throw new DomainError(
        'These goods have been delivered. Raise a customer return instead of cancelling the dispatch.',
        'DISPATCH_ALREADY_DELIVERED',
      );
    }

    const order = note.salesOrder
      ? await SalesOrder.findOne({ _id: note.salesOrder, tenantId: actor.tenantId }).session(session)
      : null;

    for (const line of note.lines) {
      await applyMovement({
        session, actor,
        product: line.product, warehouse: note.warehouse,
        bucket: order ? 'RESERVED' : 'AVAILABLE',
        quantityChange: line.quantity,
        transactionType: 'CUSTOMER_RETURN',
        referenceType: 'DISPATCH_NOTE',
        referenceId: note._id, referenceNumber: note.dispatchNoteNumber,
        remarks: `Dispatch cancelled: ${reason}`,
      });

      if (line.serialNumbers.length) {
        const serials = await SerialNumber.find({
          tenantId: actor.tenantId, serialNumber: { $in: line.serialNumbers },
        }).session(session);

        for (const serial of serials) {
          await serialService.transition({
            session, actor, serial,
            toStatus: 'RETURNED_BY_CUSTOMER', eventType: 'DISPATCH_CANCELLED',
            referenceType: 'DISPATCH_NOTE', referenceId: note._id,
            referenceNumber: note.dispatchNoteNumber,
            warehouse: note.warehouse, customer: null, remarks: reason,
          });
          await serialService.transition({
            session, actor, serial,
            toStatus: order ? 'RESERVED' : 'AVAILABLE', eventType: 'RETURNED_TO_STOCK',
            referenceType: 'DISPATCH_NOTE', referenceId: note._id,
            referenceNumber: note.dispatchNoteNumber, warehouse: note.warehouse,
          });
        }

        // The warranty never started: the goods did not reach the customer.
        await Warranty.updateMany(
          { tenantId: actor.tenantId, dispatchNote: note._id },
          { $set: { state: 'VOID', voidReason: `Dispatch cancelled: ${reason}` } },
          { session },
        );
      }

      if (order) {
        const orderLine = line.salesOrderLineId ? order.lines.id(line.salesOrderLineId) : null;
        if (orderLine) orderLine.dispatchedQuantity = Math.max(0, orderLine.dispatchedQuantity - line.quantity);
      }
    }

    if (order) {
      order.recalculateStatus();
      await order.save({ session });
    }

    note.status = 'CANCELLED';
    note.cancelReason = reason;
    note.cancelledBy = actor.id;
    await note.save({ session });

    onCommit(() => writeAudit({
      action: 'DISPATCH_CANCELLED', module: 'DispatchNote', recordId: note._id,
      recordLabel: note.dispatchNoteNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: { reason },
    }));

    return note._id;
  });

  return getDispatchNote(actor, noteId);
}

/** Everything a customer holds — the "what do we have at this site" question. */
export async function customerAssets(actor, customerId, { page = 1, limit = 50 } = {}) {
  const filter = { tenantId: actor.tenantId, customer: customerId, status: { $ne: 'SCRAPPED' } };

  const [items, total] = await Promise.all([
    SerialNumber.find(filter).sort({ dispatchDate: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('product', 'name sku')
      .populate('currentWarranty'),
    SerialNumber.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

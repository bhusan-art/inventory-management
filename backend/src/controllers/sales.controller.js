import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as orderService from '../services/sales/salesOrderService.js';
import * as dispatchService from '../services/sales/dispatchService.js';
import { warrantyStatus, daysRemaining } from '../utils/dates.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? {
      id: String(v._id),
      name: v.name ?? v.customerName ?? v.fullName ?? null,
      code: v.code ?? v.sku ?? v.customerCode ?? null,
    }
  : v ? String(v) : null);

export function serializeSalesOrder(order) {
  if (!order) return null;
  const d = order.toObject ? order.toObject() : order;

  const lines = (d.lines ?? []).map((l) => ({
    id: String(l._id),
    product: ref(l.product),
    orderedQuantity: l.orderedQuantity,
    reservedQuantity: l.reservedQuantity,
    dispatchedQuantity: l.dispatchedQuantity,
    cancelledQuantity: l.cancelledQuantity,
    outstandingQuantity: Math.max(0, l.orderedQuantity - l.dispatchedQuantity - l.cancelledQuantity),
    reservedSerialNumbers: l.reservedSerialNumbers ?? [],
    remarks: l.remarks ?? null,
  }));

  return {
    id: String(d._id),
    salesOrderNumber: d.salesOrderNumber,
    customer: ref(d.customer),
    customerPoReference: d.customerPoReference ?? null,
    warehouse: ref(d.warehouse),
    orderDate: d.orderDate,
    requiredByDate: d.requiredByDate ?? null,
    projectReference: d.projectReference ?? null,
    status: d.status,
    lines,
    totals: {
      ordered: lines.reduce((s, l) => s + l.orderedQuantity, 0),
      reserved: lines.reduce((s, l) => s + l.reservedQuantity, 0),
      dispatched: lines.reduce((s, l) => s + l.dispatchedQuantity, 0),
      outstanding: lines.reduce((s, l) => s + l.outstandingQuantity, 0),
    },
    confirmedBy: ref(d.confirmedBy),
    confirmedAt: d.confirmedAt ?? null,
    cancelReason: d.cancelReason ?? null,
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
}

export function serializeDispatchNote(note) {
  if (!note) return null;
  const d = note.toObject ? note.toObject() : note;

  const lines = (d.lines ?? []).map((l) => ({
    id: String(l._id),
    product: ref(l.product),
    quantity: l.quantity,
    serialNumbers: l.serialNumbers ?? [],
    remarks: l.remarks ?? null,
  }));

  return {
    id: String(d._id),
    dispatchNoteNumber: d.dispatchNoteNumber,
    salesOrder: d.salesOrder && typeof d.salesOrder === 'object'
      ? { id: String(d.salesOrder._id), salesOrderNumber: d.salesOrder.salesOrderNumber }
      : d.salesOrder ? String(d.salesOrder) : null,
    customer: ref(d.customer),
    warehouse: ref(d.warehouse),
    dispatchDate: d.dispatchDate,
    deliveredDate: d.deliveredDate ?? null,
    receivedByName: d.receivedByName ?? null,
    shippingAddress: d.shippingAddress ?? null,
    vehicleNumber: d.vehicleNumber ?? null,
    transporter: d.transporter ?? null,
    lrNumber: d.lrNumber ?? null,
    status: d.status,
    lines,
    totals: {
      units: lines.reduce((s, l) => s + l.quantity, 0),
      serials: lines.reduce((s, l) => s + l.serialNumbers.length, 0),
    },
    cancelReason: d.cancelReason ?? null,
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
}

// ---------------------------------------------------------------- sales orders

export const listOrders = asyncHandler(async (req, res) => {
  const { items, meta } = await orderService.listSalesOrders(req.actor, req.query);
  return ok(res, { data: items.map(serializeSalesOrder), meta });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getSalesOrder(req.actor, req.params.id);
  return ok(res, { data: serializeSalesOrder(order) });
});

export const createOrder = asyncHandler(async (req, res) => {
  const order = await orderService.createSalesOrder(req.actor, req.body);
  return created(res, {
    message: 'Sales order created as draft — confirm it to reserve stock',
    data: serializeSalesOrder(order),
  });
});

export const confirmOrder = asyncHandler(async (req, res) => {
  const order = await orderService.confirmSalesOrder(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Order confirmed — stock reserved', data: serializeSalesOrder(order) });
});

export const releaseOrder = asyncHandler(async (req, res) => {
  const order = await orderService.releaseReservation(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Reservation released — stock returned to available', data: serializeSalesOrder(order) });
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const order = await orderService.cancelSalesOrder(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Sales order cancelled', data: serializeSalesOrder(order) });
});

// -------------------------------------------------------------- dispatch notes

export const listDispatches = asyncHandler(async (req, res) => {
  const { items, meta } = await dispatchService.listDispatchNotes(req.actor, req.query);
  return ok(res, { data: items.map(serializeDispatchNote), meta });
});

export const getDispatch = asyncHandler(async (req, res) => {
  const note = await dispatchService.getDispatchNote(req.actor, req.params.id);
  return ok(res, { data: serializeDispatchNote(note) });
});

export const createDispatch = asyncHandler(async (req, res) => {
  const note = await dispatchService.createDispatch(req.actor, req.body, {
    idempotencyKey: req.get('idempotency-key') ?? null,
  });
  return created(res, {
    message: 'Goods dispatched — warranties created and stock released',
    data: serializeDispatchNote(note),
  });
});

export const markDelivered = asyncHandler(async (req, res) => {
  const note = await dispatchService.markDelivered(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Marked as delivered', data: serializeDispatchNote(note) });
});

export const cancelDispatch = asyncHandler(async (req, res) => {
  const note = await dispatchService.cancelDispatch(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Dispatch cancelled — stock returned', data: serializeDispatchNote(note) });
});

/** What a customer currently holds, with live warranty state. */
export const customerAssets = asyncHandler(async (req, res) => {
  const { items, meta } = await dispatchService.customerAssets(req.actor, req.params.customerId, {
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 50,
  });

  return ok(res, {
    data: items.map((s) => ({
      id: String(s._id),
      serialNumber: s.serialNumber,
      product: ref(s.product),
      status: s.status,
      dispatchDate: s.dispatchDate ?? null,
      installationLocation: s.installationLocation ?? null,
      warranty: s.currentWarranty
        ? {
            id: String(s.currentWarranty._id),
            warrantyNumber: s.currentWarranty.warrantyNumber,
            endDate: s.currentWarranty.endDate,
            // Computed, never stored — see utils/dates.js.
            status: warrantyStatus(s.currentWarranty),
            daysRemaining: daysRemaining(s.currentWarranty),
          }
        : null,
    })),
    meta,
  });
});

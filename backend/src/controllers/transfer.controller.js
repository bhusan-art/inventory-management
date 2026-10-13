import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as transferService from '../services/transfer/transferService.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? { id: String(v._id), name: v.name ?? v.fullName ?? null, code: v.code ?? v.sku ?? null }
  : v ? String(v) : null);

export function serializeTransfer(t) {
  if (!t) return null;
  const d = t.toObject ? t.toObject() : t;

  const lines = (d.lines ?? []).map((l) => {
    const inTransit = l.dispatchedQuantity - l.receivedQuantity - l.damagedInTransitQuantity;
    return {
      id: String(l._id),
      product: ref(l.product),
      requestedQuantity: l.requestedQuantity,
      dispatchedQuantity: l.dispatchedQuantity,
      receivedQuantity: l.receivedQuantity,
      damagedInTransitQuantity: l.damagedInTransitQuantity,
      inTransitQuantity: Math.max(0, inTransit),
      serialNumbers: l.serialNumbers ?? [],
      receivedSerials: l.receivedSerials ?? [],
      damagedSerials: l.damagedSerials ?? [],
      // Serials still on the truck — what the receiving clerk scans against.
      pendingSerials: (l.serialNumbers ?? []).filter(
        (s) => !(l.receivedSerials ?? []).includes(s) && !(l.damagedSerials ?? []).includes(s),
      ),
      remarks: l.remarks ?? null,
    };
  });

  return {
    id: String(d._id),
    transferNumber: d.transferNumber,
    sourceWarehouse: ref(d.sourceWarehouse),
    destinationWarehouse: ref(d.destinationWarehouse),
    status: d.status,
    lines,
    totals: {
      requested: lines.reduce((s, l) => s + l.requestedQuantity, 0),
      inTransit: lines.reduce((s, l) => s + l.inTransitQuantity, 0),
      received: lines.reduce((s, l) => s + l.receivedQuantity, 0),
      damaged: lines.reduce((s, l) => s + l.damagedInTransitQuantity, 0),
    },
    requestedBy: ref(d.requestedBy),
    approvedBy: ref(d.approvedBy),
    dispatchedBy: ref(d.dispatchedBy),
    receivedBy: ref(d.receivedBy),
    requestedAt: d.requestedAt,
    dispatchedAt: d.dispatchedAt ?? null,
    receivedAt: d.receivedAt ?? null,
    vehicleNumber: d.vehicleNumber ?? null,
    cancelReason: d.cancelReason ?? null,
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
}

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await transferService.listTransfers(req.actor, req.query);
  return ok(res, { data: items.map(serializeTransfer), meta });
});

export const getById = asyncHandler(async (req, res) => {
  const t = await transferService.getTransfer(req.actor, req.params.id);
  return ok(res, { data: serializeTransfer(t) });
});

export const create = asyncHandler(async (req, res) => {
  const t = await transferService.createTransfer(req.actor, req.body);
  return created(res, { message: 'Transfer requested — awaiting approval', data: serializeTransfer(t) });
});

export const approve = asyncHandler(async (req, res) => {
  const t = await transferService.approveTransfer(req.actor, req.params.id);
  return ok(res, { message: 'Transfer approved', data: serializeTransfer(t) });
});

export const dispatch = asyncHandler(async (req, res) => {
  const t = await transferService.dispatchTransfer(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Dispatched — goods now in transit', data: serializeTransfer(t) });
});

export const receive = asyncHandler(async (req, res) => {
  const t = await transferService.receiveTransfer(req.actor, req.params.id, req.body);
  const inTransit = serializeTransfer(t).totals.inTransit;
  return ok(res, {
    message: inTransit === 0
      ? 'Transfer fully received'
      : `Receipt recorded — ${inTransit} unit${inTransit === 1 ? '' : 's'} still in transit`,
    data: serializeTransfer(t),
  });
});

export const cancel = asyncHandler(async (req, res) => {
  const t = await transferService.cancelTransfer(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Transfer cancelled', data: serializeTransfer(t) });
});

import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as customerReturns from '../services/returns/customerReturnService.js';
import * as vendorReturns from '../services/returns/vendorReturnService.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? {
      id: String(v._id),
      name: v.name ?? v.customerName ?? v.vendorName ?? v.fullName ?? null,
      code: v.code ?? v.sku ?? v.customerCode ?? v.vendorCode ?? null,
    }
  : v ? String(v) : null);

const serialRef = (s) => (s && typeof s === 'object' && s._id
  ? { id: String(s._id), serialNumber: s.serialNumber, status: s.status ?? null }
  : s ? String(s) : null);

export function serializeCustomerReturn(r) {
  if (!r) return null;
  const d = r.toObject ? r.toObject({ virtuals: true }) : r;

  const lines = (d.lines ?? []).map((l) => {
    const decided = (l.dispositions ?? []).reduce((s, x) => s + x.quantity, 0);
    return {
      id: String(l._id),
      product: ref(l.product),
      requestedQuantity: l.requestedQuantity,
      receivedQuantity: l.receivedQuantity,
      // Computed from the dispositions, never stored: the two could disagree.
      dispositionedQuantity: decided,
      pendingQuantity: Math.max(0, l.receivedQuantity - decided),
      // A customer claiming five and sending four is a fact worth keeping.
      shortfall: Math.max(0, l.requestedQuantity - l.receivedQuantity),
      reportedCondition: l.reportedCondition ?? null,
      serialNumbers: (l.serialNumbers ?? []).map(serialRef),
      dispositions: (l.dispositions ?? []).map((x) => ({
        id: String(x._id),
        disposition: x.disposition,
        quantity: x.quantity,
        serialNumbers: (x.serialNumbers ?? []).map(serialRef),
        vendorReturn: x.vendorReturn && typeof x.vendorReturn === 'object'
          ? { id: String(x.vendorReturn._id), returnNumber: x.vendorReturn.returnNumber }
          : null,
        inspectionNotes: x.inspectionNotes ?? null,
        decidedBy: ref(x.decidedBy),
        decidedAt: x.decidedAt,
      })),
      remarks: l.remarks ?? null,
    };
  });

  return {
    id: String(d._id),
    returnNumber: d.returnNumber,
    customer: ref(d.customer),
    warehouse: ref(d.warehouse),
    dispatchNote: d.dispatchNote && typeof d.dispatchNote === 'object'
      ? { id: String(d.dispatchNote._id), dispatchNoteNumber: d.dispatchNote.dispatchNoteNumber }
      : null,
    reason: d.reason,
    reasonDetail: d.reasonDetail ?? null,
    status: d.status,
    lines,
    totals: {
      requested: lines.reduce((s, l) => s + l.requestedQuantity, 0),
      received: lines.reduce((s, l) => s + l.receivedQuantity, 0),
      pendingDisposition: lines.reduce((s, l) => s + l.pendingQuantity, 0),
    },
    requestedDate: d.requestedDate,
    approvedBy: ref(d.approvedBy),
    approvedAt: d.approvedAt ?? null,
    rejectionReason: d.rejectionReason ?? null,
    receivedAt: d.receivedAt ?? null,
    receivedBy: ref(d.receivedBy),
    closedAt: d.closedAt ?? null,
    warrantiesVoidedCount: (d.warrantiesVoided ?? []).length,
    createdAt: d.createdAt,
  };
}

export function serializeVendorReturn(r) {
  if (!r) return null;
  const d = r.toObject ? r.toObject({ virtuals: true }) : r;

  const lines = (d.lines ?? []).map((l) => ({
    id: String(l._id),
    product: ref(l.product),
    quantity: l.quantity,
    sourceBucket: l.sourceBucket,
    serialNumbers: (l.serialNumbers ?? []).map(serialRef),
    customerReturn: l.customerReturn && typeof l.customerReturn === 'object'
      ? { id: String(l.customerReturn._id), returnNumber: l.customerReturn.returnNumber }
      : null,
    remarks: l.remarks ?? null,
  }));

  return {
    id: String(d._id),
    returnNumber: d.returnNumber,
    vendor: ref(d.vendor),
    warehouse: ref(d.warehouse),
    grn: d.grn && typeof d.grn === 'object'
      ? { id: String(d.grn._id), grnNumber: d.grn.grnNumber }
      : null,
    reason: d.reason,
    reasonDetail: d.reasonDetail ?? null,
    status: d.status,
    lines,
    totals: { units: lines.reduce((s, l) => s + l.quantity, 0) },
    expectReplacement: d.expectReplacement,
    vendorRmaNumber: d.vendorRmaNumber ?? null,
    courier: d.courier ?? null,
    trackingNumber: d.trackingNumber ?? null,
    approvedBy: ref(d.approvedBy),
    approvedAt: d.approvedAt ?? null,
    rejectionReason: d.rejectionReason ?? null,
    sentAt: d.sentAt ?? null,
    sentBy: ref(d.sentBy),
    closedAt: d.closedAt ?? null,
    closureNotes: d.closureNotes ?? null,
    createdAt: d.createdAt,
  };
}

// ----------------------------------------------------------- customer returns

export const listCustomerReturns = asyncHandler(async (req, res) => {
  const { items, meta } = await customerReturns.listCustomerReturns(req.actor, req.query);
  return ok(res, { data: items.map(serializeCustomerReturn), meta });
});

export const getCustomerReturn = asyncHandler(async (req, res) => {
  const doc = await customerReturns.getCustomerReturn(req.actor, req.params.id);
  return ok(res, { data: serializeCustomerReturn(doc) });
});

export const createCustomerReturn = asyncHandler(async (req, res) => {
  const doc = await customerReturns.createCustomerReturn(req.actor, req.body);
  return created(res, { message: 'Return request raised', data: serializeCustomerReturn(doc) });
});

export const setCustomerReturnStatus = asyncHandler(async (req, res) => {
  const doc = await customerReturns.setCustomerReturnStatus(req.actor, req.params.id, req.body);
  return ok(res, { message: `Return ${req.body.status.toLowerCase()}`, data: serializeCustomerReturn(doc) });
});

export const receiveCustomerReturn = asyncHandler(async (req, res) => {
  const doc = await customerReturns.receiveCustomerReturn(req.actor, req.params.id, req.body, {
    idempotencyKey: req.get('Idempotency-Key') ?? null,
  });
  return ok(res, {
    message: 'Goods received into quarantine, awaiting inspection',
    data: serializeCustomerReturn(doc),
  });
});

export const setDisposition = asyncHandler(async (req, res) => {
  const doc = await customerReturns.setDisposition(req.actor, req.params.id, req.body);
  return ok(res, {
    message: `Disposition set: ${req.body.disposition}`,
    data: serializeCustomerReturn(doc),
  });
});

export const dispositionQueue = asyncHandler(async (req, res) => {
  const rows = await customerReturns.dispositionQueue(req.actor);
  return ok(res, {
    data: rows.map(({ doc, pending }) => ({
      ...serializeCustomerReturn(doc),
      pendingDisposition: pending,
    })),
  });
});

export const serialReturnHistory = asyncHandler(async (req, res) => {
  const { customerReturns: cr, vendorReturns: vr } =
    await customerReturns.serialReturnHistory(req.actor, req.params.serialId);

  return ok(res, {
    data: {
      customerReturns: cr.map((d) => ({
        id: String(d._id), returnNumber: d.returnNumber, status: d.status,
        reason: d.reason, requestedDate: d.requestedDate, receivedAt: d.receivedAt ?? null,
      })),
      vendorReturns: vr.map((d) => ({
        id: String(d._id), returnNumber: d.returnNumber, status: d.status,
        reason: d.reason, vendor: ref(d.vendor), sentAt: d.sentAt ?? null,
      })),
    },
  });
});

// ------------------------------------------------------------- vendor returns

export const listVendorReturns = asyncHandler(async (req, res) => {
  const { items, meta } = await vendorReturns.listVendorReturns(req.actor, req.query);
  return ok(res, { data: items.map(serializeVendorReturn), meta });
});

export const getVendorReturn = asyncHandler(async (req, res) => {
  const doc = await vendorReturns.getVendorReturn(req.actor, req.params.id);
  return ok(res, { data: serializeVendorReturn(doc) });
});

export const createVendorReturn = asyncHandler(async (req, res) => {
  const doc = await vendorReturns.createVendorReturn(req.actor, req.body);
  return created(res, { message: 'Vendor return drafted', data: serializeVendorReturn(doc) });
});

export const setVendorReturnStatus = asyncHandler(async (req, res) => {
  const doc = await vendorReturns.setVendorReturnStatus(req.actor, req.params.id, req.body);
  return ok(res, { message: `Return ${req.body.status.toLowerCase()}`, data: serializeVendorReturn(doc) });
});

export const sendVendorReturn = asyncHandler(async (req, res) => {
  const doc = await vendorReturns.sendVendorReturn(req.actor, req.params.id, req.body, {
    idempotencyKey: req.get('Idempotency-Key') ?? null,
  });
  return ok(res, { message: 'Goods sent back to vendor', data: serializeVendorReturn(doc) });
});

export const vendorReturnFromCustomerReturn = asyncHandler(async (req, res) => {
  const doc = await vendorReturns.fromCustomerReturn(req.actor, req.params.id, req.body);
  return created(res, {
    message: 'Vendor return drafted from the customer return',
    data: serializeVendorReturn(doc),
  });
});

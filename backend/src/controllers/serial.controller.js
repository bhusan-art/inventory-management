import asyncHandler from '../utils/asyncHandler.js';
import { warrantyStatus, daysRemaining } from '../utils/dates.js';
import { ok } from '../utils/response.js';
import { SerialNumber } from '../models/SerialNumber.js';
import * as query from '../services/serial/serialQueryService.js';
import * as serialService from '../services/serial/serialService.js';
import * as labelService from '../services/serial/labelService.js';
import { importSerials } from '../services/serial/serialImport.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? {
      id: String(v._id),
      name: v.name ?? v.customerName ?? v.vendorName ?? v.fullName ?? null,
      code: v.code ?? v.sku ?? v.customerCode ?? v.vendorCode ?? null,
    }
  : v ? String(v) : null);

export function serializeSerial(s) {
  if (!s) return null;
  const d = s.toObject ? s.toObject() : s;
  return {
    id: String(d._id),
    serialNumber: d.serialNumber,
    product: ref(d.product),
    status: d.status,
    condition: d.condition,
    warehouse: ref(d.warehouse),
    rackLocation: d.rackLocation ?? null,
    customer: ref(d.customer),
    vendor: ref(d.vendor),
    grn: d.grn && typeof d.grn === 'object'
      ? { id: String(d.grn._id), grnNumber: d.grn.grnNumber, receivedDate: d.grn.receivedDate }
      : d.grn ? String(d.grn) : null,
    assetTag: d.assetTag ?? null,
    macAddress: d.macAddress ?? null,
    imei: d.imei ?? null,
    batchNumber: d.batchNumber ?? null,
    manufacturingDate: d.manufacturingDate ?? null,
    receivedDate: d.receivedDate ?? null,
    dispatchDate: d.dispatchDate ?? null,
    installationLocation: d.installationLocation ?? null,
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const serializeEvent = (e) => {
  const d = e.toObject ? e.toObject() : e;
  return {
    id: String(d._id),
    fromStatus: d.fromStatus,
    toStatus: d.toStatus,
    eventType: d.eventType,
    reference: { type: d.referenceType, number: d.referenceNumber, id: d.referenceId ? String(d.referenceId) : null },
    warehouse: ref(d.warehouse),
    customer: ref(d.customer),
    performedBy: ref(d.performedBy),
    remarks: d.remarks ?? null,
    createdAt: d.createdAt,
  };
};

export const list = asyncHandler(async (req, res) => {
  const { items, meta } = await query.listSerials(req.actor, req.query);
  return ok(res, { data: items.map(serializeSerial), meta });
});

/** The scan endpoint. Everything a person holding the unit needs, in one call. */
export const scan = asyncHandler(async (req, res) => {
  const result = await query.findBySerialNumber(req.actor, req.params.serialNumber);
  return ok(res, {
    data: {
      ...serializeSerial(result.serial),
      countsAsStock: result.countsAsStock,
      allowedTransitions: result.allowedTransitions,
      movementCount: result.ledgerCount,
      // "Is this still covered?" is the first question asked of a scanned unit,
      // so the answer travels with the scan rather than needing a second call.
      // Status is computed here, as everywhere — nothing stores it.
      warranty: result.serial.currentWarranty && typeof result.serial.currentWarranty === 'object'
        ? {
            id: String(result.serial.currentWarranty._id),
            warrantyNumber: result.serial.currentWarranty.warrantyNumber,
            endDate: result.serial.currentWarranty.endDate,
            state: result.serial.currentWarranty.state,
            status: warrantyStatus(result.serial.currentWarranty),
            daysRemaining: daysRemaining(result.serial.currentWarranty),
          }
        : null,
      recentEvents: result.recentEvents.map(serializeEvent),
    },
  });
});

export const history = asyncHandler(async (req, res) => {
  const result = await query.getHistory(req.actor, req.params.id, {
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 50,
  });
  return ok(res, {
    data: {
      serial: serializeSerial(result.serial),
      events: result.events.map(serializeEvent),
      movements: result.movements.map((m) => ({
        id: String(m._id),
        transactionNumber: m.transactionNumber,
        transactionType: m.transactionType,
        warehouse: ref(m.warehouse),
        bucketFrom: m.bucketFrom,
        bucketTo: m.bucketTo,
        reference: { type: m.referenceType, number: m.referenceNumber },
        createdAt: m.createdAt,
      })),
    },
    meta: result.meta,
  });
});

export const overrideStatus = asyncHandler(async (req, res) => {
  const serial = await serialService.overrideStatus(req.actor, req.params.id, req.body);
  return ok(res, { message: `Status changed to ${req.body.toStatus}`, data: serializeSerial(serial) });
});

export const updateAttributes = asyncHandler(async (req, res) => {
  const serial = await serialService.updateAttributes(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Serial updated', data: serializeSerial(serial) });
});

export const qrCode = asyncHandler(async (req, res) => {
  const serial = await labelService.getLabelData(req.actor, req.params.id);
  const svg = await labelService.generateQrSvg(serial.serialNumber);
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600');
  return res.send(svg);
});

export const barcode = asyncHandler(async (req, res) => {
  const serial = await labelService.getLabelData(req.actor, req.params.id);
  const svg = await labelService.generateBarcodeSvg(serial.serialNumber);
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600');
  return res.send(svg);
});

/** Printable sheet — one serial, or several via ?ids=a,b,c */
export const labels = asyncHandler(async (req, res) => {
  const ids = req.query.ids ? String(req.query.ids).split(',') : [req.params.id];
  const serials = await SerialNumber.find({ _id: { $in: ids }, tenantId: req.actor.tenantId })
    .populate('product', 'name sku').populate('warehouse', 'code').limit(200);

  const html = await labelService.renderLabelSheet(serials, { copies: Number(req.query.copies) || 1 });
  res.type('text/html');
  return res.send(html);
});

export const bulkImport = asyncHandler(async (req, res) => {
  const summary = await importSerials(req.actor, req.body);
  return ok(res, { message: summary.message, data: summary });
});

export const consistencyCheck = asyncHandler(async (req, res) => {
  const result = await query.auditSerialConsistency(req.actor.tenantId, req.params.productId);
  return ok(res, {
    message: result.mismatches.length === 0
      ? 'Serial records and quantities agree.'
      : `${result.mismatches.length} mismatch(es) between serial records and quantities.`,
    data: result,
  });
});

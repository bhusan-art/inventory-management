import asyncHandler from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import * as warrantyService from '../services/warranty/warrantyService.js';
import * as serviceService from '../services/warranty/serviceRequestService.js';
import { SERVICE_TRANSITIONS } from '../models/ServiceRequest.js';
import { warrantyStatus, daysRemaining } from '../utils/dates.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? {
      id: String(v._id),
      name: v.name ?? v.customerName ?? v.vendorName ?? v.fullName ?? null,
      code: v.code ?? v.sku ?? v.customerCode ?? v.serialNumber ?? null,
    }
  : v ? String(v) : null);

export function serializeWarranty(w) {
  if (!w) return null;
  const d = w.toObject ? w.toObject() : w;
  return {
    id: String(d._id),
    warrantyNumber: d.warrantyNumber,
    product: ref(d.product),
    customer: ref(d.customer),
    serialNumber: d.serialNumber && typeof d.serialNumber === 'object'
      ? { id: String(d.serialNumber._id), serialNumber: d.serialNumber.serialNumber, status: d.serialNumber.status }
      : d.serialNumber ? String(d.serialNumber) : null,
    dispatchNote: d.dispatchNote && typeof d.dispatchNote === 'object'
      ? { id: String(d.dispatchNote._id), dispatchNoteNumber: d.dispatchNote.dispatchNoteNumber }
      : null,
    startDate: d.startDate,
    endDate: d.endDate,
    durationMonths: d.durationMonths,
    provider: d.provider,
    state: d.state,
    // Computed on every read — there is no stored status field.
    status: warrantyStatus(d),
    daysRemaining: daysRemaining(d),
    voidReason: d.voidReason ?? null,
    previousWarranty: d.previousWarranty && typeof d.previousWarranty === 'object'
      ? { id: String(d.previousWarranty._id), warrantyNumber: d.previousWarranty.warrantyNumber }
      : null,
    createdAt: d.createdAt,
  };
}

export function serializeServiceRequest(t) {
  if (!t) return null;
  const d = t.toObject ? t.toObject() : t;
  return {
    id: String(d._id),
    ticketNumber: d.ticketNumber,
    customer: ref(d.customer),
    product: ref(d.product),
    serialNumber: d.serialNumber && typeof d.serialNumber === 'object'
      ? { id: String(d.serialNumber._id), serialNumber: d.serialNumber.serialNumber, status: d.serialNumber.status }
      : d.serialNumber ? String(d.serialNumber) : null,
    replacementSerialNumber: d.replacementSerialNumber && typeof d.replacementSerialNumber === 'object'
      ? { id: String(d.replacementSerialNumber._id), serialNumber: d.replacementSerialNumber.serialNumber }
      : null,
    warranty: d.warranty && typeof d.warranty === 'object' ? serializeWarranty(d.warranty) : null,
    // Frozen at raise time — see serviceRequestService.createServiceRequest.
    warrantyApplicable: d.warrantyApplicable,
    warrantyEndDateAtRaise: d.warrantyEndDateAtRaise ?? null,
    issueDescription: d.issueDescription,
    reportedDate: d.reportedDate,
    priority: d.priority,
    slaDueDate: d.slaDueDate ?? null,
    slaBreached: Boolean(
      d.slaDueDate && !['CLOSED', 'REJECTED', 'REPAIRED', 'REPLACED'].includes(d.status)
      && new Date(d.slaDueDate) < new Date(),
    ),
    status: d.status,
    // Sent so the UI offers exactly the moves the API will accept. Derived from
    // the same table the service enforces, so the two cannot drift: a button
    // the backend would refuse is never drawn.
    allowedTransitions: SERVICE_TRANSITIONS[d.status] ?? [],
    receivedAt: d.receivedAt ?? null,
    returnedAt: d.returnedAt ?? null,
    assignedTo: ref(d.assignedTo),
    vendor: ref(d.vendor),
    vendorRmaNumber: d.vendorRmaNumber ?? null,
    rootCause: d.rootCause ?? null,
    resolution: d.resolution ?? null,
    closedAt: d.closedAt ?? null,
    activity: (d.activity ?? []).map((a) => ({
      id: String(a._id),
      fromStatus: a.fromStatus ?? null,
      toStatus: a.toStatus,
      note: a.note ?? null,
      performedBy: ref(a.performedBy),
      at: a.at,
    })),
    createdAt: d.createdAt,
  };
}

// ------------------------------------------------------------------ warranty

export const listWarranties = asyncHandler(async (req, res) => {
  const { items, meta } = await warrantyService.listWarranties(req.actor, req.query);
  return ok(res, { data: items.map(serializeWarranty), meta });
});

export const getWarranty = asyncHandler(async (req, res) => {
  const warranty = await warrantyService.getWarranty(req.actor, req.params.id);
  return ok(res, { data: serializeWarranty(warranty) });
});

export const voidWarranty = asyncHandler(async (req, res) => {
  const warranty = await warrantyService.voidWarranty(req.actor, req.params.id, req.body.reason);
  return ok(res, { message: 'Warranty voided', data: serializeWarranty(warranty) });
});

export const extendWarranty = asyncHandler(async (req, res) => {
  const warranty = await warrantyService.extendWarranty(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Warranty extended', data: serializeWarranty(warranty) });
});

export const warrantySummary = asyncHandler(async (req, res) => {
  const summary = await warrantyService.warrantySummary(req.actor);
  return ok(res, { data: summary });
});

export const serialWarrantyHistory = asyncHandler(async (req, res) => {
  const items = await warrantyService.serialWarrantyHistory(req.actor, req.params.serialId);
  return ok(res, { data: items.map(serializeWarranty) });
});

// ------------------------------------------------------------------- service

export const listServiceRequests = asyncHandler(async (req, res) => {
  const { items, meta } = await serviceService.listServiceRequests(req.actor, req.query);
  return ok(res, { data: items.map(serializeServiceRequest), meta });
});

export const getServiceRequest = asyncHandler(async (req, res) => {
  const ticket = await serviceService.getServiceRequest(req.actor, req.params.id);
  return ok(res, { data: serializeServiceRequest(ticket) });
});

export const createServiceRequest = asyncHandler(async (req, res) => {
  const ticket = await serviceService.createServiceRequest(req.actor, req.body);
  return created(res, {
    message: ticket.warrantyApplicable
      ? 'Ticket raised — covered under warranty'
      : 'Ticket raised — not covered under warranty',
    data: serializeServiceRequest(ticket),
  });
});

export const assignServiceRequest = asyncHandler(async (req, res) => {
  const ticket = await serviceService.assignServiceRequest(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Ticket updated', data: serializeServiceRequest(ticket) });
});

export const receiveForService = asyncHandler(async (req, res) => {
  const ticket = await serviceService.receiveForService(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Unit received for service', data: serializeServiceRequest(ticket) });
});

export const updateServiceStatus = asyncHandler(async (req, res) => {
  const ticket = await serviceService.updateStatus(req.actor, req.params.id, req.body);
  return ok(res, { message: `Ticket moved to ${req.body.status}`, data: serializeServiceRequest(ticket) });
});

export const returnRepairedUnit = asyncHandler(async (req, res) => {
  const ticket = await serviceService.returnRepairedUnit(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Unit returned to customer and ticket closed', data: serializeServiceRequest(ticket) });
});

export const replaceUnit = asyncHandler(async (req, res) => {
  const ticket = await serviceService.replaceUnit(req.actor, req.params.id, req.body);
  return ok(res, {
    message: 'Replacement issued — warranty carried over to the new unit',
    data: serializeServiceRequest(ticket),
  });
});

export const closeServiceRequest = asyncHandler(async (req, res) => {
  const ticket = await serviceService.closeServiceRequest(req.actor, req.params.id, req.body);
  return ok(res, { message: 'Ticket closed', data: serializeServiceRequest(ticket) });
});

export const serialServiceHistory = asyncHandler(async (req, res) => {
  const items = await serviceService.serialServiceHistory(req.actor, req.params.serialId);
  return ok(res, { data: items.map(serializeServiceRequest) });
});

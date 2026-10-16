import { Warranty } from '../../models/Warranty.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { ServiceRequest } from '../../models/ServiceRequest.js';
import { writeAudit } from '../shared/auditService.js';
import { escapeRegex } from '../shared/crudFactory.js';
import { warrantyStatus, daysRemaining, addMonths, EXPIRING_SOON_DAYS } from '../../utils/dates.js';
import { NotFoundError, DomainError } from '../../utils/errors.js';

/**
 * Warranty reads.
 *
 * Status is DERIVED on every read (ARCHITECTURE.md §0.2) — there is no stored
 * ACTIVE/EXPIRED field and no job that writes one. Date filters therefore work
 * on `endDate`, which is indexed, rather than on a status string that would
 * have to be kept current.
 */
export async function listWarranties(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null };
  if (query.customer) filter.customer = query.customer;
  if (query.product) filter.product = query.product;
  if (query.state) filter.state = query.state;
  if (query.search) {
    // Warranty numbers are the only free-text handle a user has here; product
    // and customer are already filterable by id from the screen.
    filter.warrantyNumber = { $regex: escapeRegex(String(query.search).toUpperCase()), $options: 'i' };
  }

  const now = new Date();

  // "Expiring soon" and "expired" are ranges over endDate, not stored flags.
  if (query.status === 'EXPIRED') {
    filter.endDate = { $lt: startOfDay(now) };
    filter.state = filter.state ?? 'ACTIVE';
  } else if (query.status === 'EXPIRING_SOON') {
    filter.endDate = { $gte: startOfDay(now), $lte: endOfDay(addDays(now, query.days ?? EXPIRING_SOON_DAYS)) };
    filter.state = filter.state ?? 'ACTIVE';
  } else if (query.status === 'ACTIVE') {
    filter.endDate = { $gt: endOfDay(addDays(now, query.days ?? EXPIRING_SOON_DAYS)) };
    filter.state = filter.state ?? 'ACTIVE';
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    Warranty.find(filter).sort({ endDate: 1 }).skip((page - 1) * limit).limit(limit)
      .populate('product', 'name sku')
      .populate('customer', 'customerName customerCode')
      .populate('serialNumber', 'serialNumber status')
      .populate('dispatchNote', 'dispatchNoteNumber'),
    Warranty.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getWarranty(actor, id) {
  const warranty = await Warranty.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('product', 'name sku warrantyMonths')
    .populate('customer', 'customerName customerCode')
    .populate('serialNumber', 'serialNumber status installationLocation')
    .populate('dispatchNote', 'dispatchNoteNumber dispatchDate')
    .populate('previousWarranty', 'warrantyNumber endDate');

  if (!warranty) throw new NotFoundError('Warranty not found');
  return warranty;
}

/** Every warranty a unit has ever had, including replacements. */
export async function serialWarrantyHistory(actor, serialId) {
  return Warranty.find({ tenantId: actor.tenantId, serialNumber: serialId })
    .sort({ startDate: -1 })
    .populate('customer', 'customerName')
    .populate('dispatchNote', 'dispatchNoteNumber');
}

/**
 * Voids a warranty — misuse, tampering, a unit sold in error.
 *
 * `state` is the only part of warranty status that is stored, because it
 * records a human decision rather than the passage of time.
 */
export async function voidWarranty(actor, id, reason) {
  const warranty = await Warranty.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!warranty) throw new NotFoundError('Warranty not found');

  if (warranty.state !== 'ACTIVE') {
    throw new DomainError(`This warranty is already ${warranty.state.toLowerCase()}`, 'WARRANTY_NOT_ACTIVE');
  }

  const openTickets = await ServiceRequest.countDocuments({
    tenantId: actor.tenantId, warranty: warranty._id,
    status: { $nin: ['CLOSED', 'REJECTED'] }, deletedAt: null,
  });
  if (openTickets > 0) {
    // Voiding cover underneath a live claim would change the entitlement an
    // engineer is already working to.
    throw new DomainError(
      `This warranty has ${openTickets} open service ticket(s). Close them before voiding it.`,
      'WARRANTY_HAS_OPEN_TICKETS',
    );
  }

  warranty.state = 'VOID';
  warranty.voidReason = reason;
  await warranty.save();

  await writeAudit({
    action: 'WARRANTY_VOIDED', module: 'Warranty', recordId: warranty._id,
    recordLabel: warranty.warrantyNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
    metadata: { reason },
  });

  return getWarranty(actor, warranty._id);
}

/**
 * Extends cover — an extended-warranty purchase, or goodwill.
 *
 * Recorded as a change to this warranty with an audit trail rather than a new
 * record, so the unit keeps one continuous cover period and the history shows
 * who extended it and why.
 */
export async function extendWarranty(actor, id, { additionalMonths, reason }) {
  const warranty = await Warranty.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!warranty) throw new NotFoundError('Warranty not found');

  if (warranty.state !== 'ACTIVE') {
    throw new DomainError('Only an active warranty can be extended', 'WARRANTY_NOT_ACTIVE');
  }

  const previousEnd = warranty.endDate;
  warranty.endDate = addMonths(warranty.endDate, additionalMonths);
  warranty.durationMonths += additionalMonths;
  warranty.provider = 'EXTENDED';
  warranty.terms = [warranty.terms, reason].filter(Boolean).join('\n');
  await warranty.save();

  await writeAudit({
    action: 'WARRANTY_EXTENDED', module: 'Warranty', recordId: warranty._id,
    recordLabel: warranty.warrantyNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
    changes: [{ field: 'endDate', before: previousEnd, after: warranty.endDate }],
    metadata: { additionalMonths, reason },
  });

  return getWarranty(actor, warranty._id);
}

/** Counts for the dashboard, computed from dates in one aggregation. */
export async function warrantySummary(actor) {
  const now = new Date();
  const soon = endOfDay(addDays(now, EXPIRING_SOON_DAYS));

  const [active, expiringSoon, expired, voided, underClaim] = await Promise.all([
    Warranty.countDocuments({ tenantId: actor.tenantId, state: 'ACTIVE', endDate: { $gt: soon }, deletedAt: null }),
    Warranty.countDocuments({
      tenantId: actor.tenantId, state: 'ACTIVE', deletedAt: null,
      endDate: { $gte: startOfDay(now), $lte: soon },
    }),
    Warranty.countDocuments({
      tenantId: actor.tenantId, state: 'ACTIVE', endDate: { $lt: startOfDay(now) }, deletedAt: null,
    }),
    Warranty.countDocuments({ tenantId: actor.tenantId, state: 'VOID', deletedAt: null }),
    ServiceRequest.countDocuments({
      tenantId: actor.tenantId, status: { $nin: ['CLOSED', 'REJECTED'] }, deletedAt: null,
    }),
  ]);

  return { active, expiringSoon, expired, voided, openServiceRequests: underClaim };
}

/** Attaches derived status to a warranty document for serialization. */
export function withDerivedStatus(warranty, now = new Date()) {
  if (!warranty) return null;
  const d = warranty.toObject ? warranty.toObject() : warranty;
  return { ...d, status: warrantyStatus(d, now), daysRemaining: daysRemaining(d, now) };
}

export async function findActiveForSerial(tenantId, serialId) {
  return Warranty.findOne({ tenantId, serialNumber: serialId, state: 'ACTIVE' }).sort({ endDate: -1 });
}

export { SerialNumber };

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

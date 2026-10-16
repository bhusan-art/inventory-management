import { VendorReturn } from '../../models/VendorReturn.js';
import { CustomerReturn } from '../../models/CustomerReturn.js';
import { GRN } from '../../models/GRN.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { Vendor } from '../../models/Vendor.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement, getStock } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { escapeRegex } from '../shared/crudFactory.js';
import { canMoveVendorReturn } from '../../constants/returns.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

const POPULATE = [
  { path: 'vendor', select: 'vendorName vendorCode' },
  { path: 'warehouse', select: 'name code' },
  { path: 'grn', select: 'grnNumber receivedDate' },
  { path: 'lines.product', select: 'name sku productType' },
  { path: 'lines.serialNumbers', select: 'serialNumber status condition' },
  { path: 'lines.customerReturn', select: 'returnNumber' },
  { path: 'approvedBy sentBy createdBy', select: 'fullName' },
];

export async function listVendorReturns(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.vendor) filter.vendor = query.vendor;
  if (query.warehouse) filter.warehouse = query.warehouse;
  if (query.reason) filter.reason = query.reason;
  if (query.awaitingReplacement) {
    filter.expectReplacement = true;
    filter.status = { $in: ['SENT'] };
  }
  if (query.search) {
    filter.returnNumber = { $regex: escapeRegex(String(query.search).toUpperCase()), $options: 'i' };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    VendorReturn.find(filter).sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit)
      .populate('vendor', 'vendorName vendorCode')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku'),
    VendorReturn.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getVendorReturn(actor, id) {
  const doc = await VendorReturn.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate(POPULATE);
  if (!doc) throw new NotFoundError('Return not found');
  return doc;
}

/**
 * Drafts the return. Nothing moves.
 *
 * Stock stays exactly where it is until the goods are SENT, for the same reason
 * a GRN does not add stock until it is posted: a document being prepared over
 * an afternoon must not make a shelf lie about what is on it.
 */
export async function createVendorReturn(actor, payload) {
  const vendor = await Vendor.findOne({
    _id: payload.vendor, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!vendor) throw new NotFoundError('Vendor not found');

  const warehouse = await Warehouse.findOne({
    _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!warehouse) throw new NotFoundError('Warehouse not found');

  if (payload.grn) {
    const grn = await GRN.findOne({ _id: payload.grn, tenantId: actor.tenantId, deletedAt: null });
    if (!grn) throw new NotFoundError('GRN not found');
    if (String(grn.vendor) !== String(vendor._id)) {
      throw new DomainError('That GRN belongs to a different vendor', 'GRN_VENDOR_MISMATCH');
    }
  }

  const lines = [];
  for (const line of payload.lines) {
    const product = await Product.findOne({
      _id: line.product, tenantId: actor.tenantId, deletedAt: null,
    });
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);

    // Checked again at send time under the transaction's guard; this is the
    // early, friendly failure so a draft is not built against stock that
    // plainly is not there.
    const stock = await getStock(actor.tenantId, product._id, warehouse._id);
    const bucketField = line.sourceBucket === 'AVAILABLE' ? 'availableQuantity' : 'damagedQuantity';
    const held = stock?.[bucketField] ?? 0;

    if (line.quantity > held) {
      throw new DomainError(
        `Only ${held} unit(s) of ${product.name} in the ${line.sourceBucket.toLowerCase()} bucket at ${warehouse.code}`,
        'INSUFFICIENT_STOCK',
      );
    }

    lines.push({
      product: product._id,
      quantity: line.quantity,
      sourceBucket: line.sourceBucket ?? 'DAMAGED',
      customerReturn: line.customerReturn ?? null,
      remarks: line.remarks ?? null,
    });
  }

  const returnNumber = await nextDocumentNumber('RTV');

  const doc = await VendorReturn.create({
    tenantId: actor.tenantId,
    returnNumber,
    vendor: vendor._id,
    warehouse: warehouse._id,
    grn: payload.grn ?? null,
    reason: payload.reason,
    reasonDetail: payload.reasonDetail ?? null,
    lines,
    expectReplacement: payload.expectReplacement ?? false,
    vendorRmaNumber: payload.vendorRmaNumber ?? null,
    status: 'DRAFT',
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'VENDOR_RETURN_RAISED', module: 'VendorReturn', recordId: doc._id,
    recordLabel: doc.returnNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    metadata: { vendor: vendor.vendorCode, reason: payload.reason },
  });

  return getVendorReturn(actor, doc._id);
}

export async function setVendorReturnStatus(actor, id, { status, reason }) {
  const doc = await VendorReturn.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!doc) throw new NotFoundError('Return not found');

  if (!canMoveVendorReturn(doc.status, status)) {
    throw new DomainError(
      `A return cannot move from ${doc.status} to ${status}`,
      'INVALID_STATE_TRANSITION',
      [{ code: 'INVALID_STATE_TRANSITION', from: doc.status, to: status }],
    );
  }

  if (status === 'REJECTED' && !reason) {
    throw new DomainError('A rejection needs a reason', 'REASON_REQUIRED');
  }

  const from = doc.status;
  doc.status = status;

  if (status === 'APPROVED') {
    doc.approvedBy = actor.id;
    doc.approvedAt = new Date();
  }
  if (status === 'REJECTED' || status === 'CANCELLED') {
    doc.rejectionReason = reason ?? null;
  }
  if (status === 'CLOSED') {
    doc.closedAt = new Date();
    doc.closureNotes = reason ?? null;
  }

  await doc.save();

  await writeAudit({
    action: `VENDOR_RETURN_${status}`, module: 'VendorReturn', recordId: doc._id,
    recordLabel: doc.returnNumber, severity: status === 'APPROVED' ? 'CRITICAL' : 'NOTICE',
    tenantId: actor.tenantId,
    changes: [{ field: 'status', before: from, after: status }],
  });

  return getVendorReturn(actor, doc._id);
}

/**
 * The goods physically leave.
 *
 * This is the irreversible moment, and it is the only one that touches stock.
 * Serials move to RETURNED_TO_VENDOR, which the transition table makes a dead
 * end: a unit sent back to a vendor cannot be sold, serviced or returned again.
 * If the vendor ships a replacement it arrives as a GRN, like any other goods
 * at the dock.
 */
export async function sendVendorReturn(actor, id, payload, { idempotencyKey } = {}) {
  if (idempotencyKey) {
    const existing = await VendorReturn.findOne({ tenantId: actor.tenantId, idempotencyKey });
    if (existing) return getVendorReturn(actor, existing._id);
  }

  const returnId = await withTransaction(async ({ session, onCommit }) => {
    const doc = await VendorReturn.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!doc) throw new NotFoundError('Return not found');

    if (doc.status !== 'APPROVED') {
      throw new DomainError('Only an approved return may be sent', 'RETURN_NOT_APPROVED');
    }
    if (doc.sentAt) {
      throw new ConflictError('This return has already been sent', 'ALREADY_SENT');
    }

    for (const line of doc.lines) {
      const serialIds = line.serialNumbers ?? [];

      // The guarded decrement in applyMovement is what actually prevents
      // sending stock we do not hold — the draft-time check was a courtesy.
      if (serialIds.length === 0) {
        await applyMovement({
          session, actor,
          product: line.product, warehouse: doc.warehouse,
          bucket: line.sourceBucket, quantityChange: -line.quantity,
          transactionType: 'VENDOR_RETURN',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          remarks: `Returned to vendor — ${doc.reason}`,
        });
        continue;
      }

      for (const serialId of serialIds) {
        const serial = await SerialNumber.findOne({
          _id: serialId, tenantId: actor.tenantId,
        }).session(session);
        if (!serial) throw new NotFoundError('Serial number not found');

        await applyMovement({
          session, actor,
          product: line.product, warehouse: doc.warehouse,
          bucket: line.sourceBucket, quantityChange: -1,
          transactionType: 'VENDOR_RETURN',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          serialNumber: serial._id,
          remarks: `Returned to vendor — ${doc.reason}`,
        });

        await serialService.transition({
          session, actor, serial, toStatus: 'RETURNED_TO_VENDOR',
          eventType: 'RETURNED_TO_VENDOR',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          warehouse: null, customer: null,
        });
      }
    }

    doc.status = 'SENT';
    doc.sentAt = new Date();
    doc.sentBy = actor.id;
    doc.courier = payload.courier ?? null;
    doc.trackingNumber = payload.trackingNumber ?? null;
    if (payload.vendorRmaNumber) doc.vendorRmaNumber = payload.vendorRmaNumber;
    if (idempotencyKey) doc.idempotencyKey = idempotencyKey;
    await doc.save({ session });

    onCommit(() => writeAudit({
      action: 'VENDOR_RETURN_SENT', module: 'VendorReturn', recordId: doc._id,
      recordLabel: doc.returnNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        quantity: doc.lines.reduce((s, l) => s + l.quantity, 0),
        expectReplacement: doc.expectReplacement,
        trackingNumber: payload.trackingNumber ?? null,
      },
    }));

    if (doc.expectReplacement) {
      onCommit(() => notify({
        tenantId: actor.tenantId,
        type: 'REPLACEMENT_EXPECTED',
        title: `${doc.returnNumber} sent — replacement expected`,
        body: 'The replacement will arrive as an ordinary GRN',
        severity: 'NOTICE',
        recipientPermission: 'CREATE_GRN',
        module: 'VendorReturn',
        recordId: doc._id,
        actionUrl: '/vendor-returns',
        dedupeKey: `REPLACEMENT_EXPECTED:${doc._id}`,
      }));
    }

    return doc._id;
  });

  return getVendorReturn(actor, returnId);
}

/**
 * Raises a vendor return straight from a dispositioned customer return.
 *
 * The common case: a customer sends back a faulty unit, inspection confirms it
 * is the manufacturer's fault, and it goes back up the chain. Links both
 * documents so the unit's history reads continuously from customer to vendor.
 */
export async function fromCustomerReturn(actor, customerReturnId, payload) {
  const source = await CustomerReturn.findOne({
    _id: customerReturnId, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!source) throw new NotFoundError('Customer return not found');

  const rtvLines = [];
  for (const line of source.lines) {
    const forVendor = (line.dispositions ?? []).filter((d) => d.disposition === 'RETURN_TO_VENDOR');
    const quantity = forVendor.reduce((s, d) => s + d.quantity, 0);
    if (quantity === 0) continue;

    rtvLines.push({
      product: line.product,
      quantity,
      sourceBucket: 'DAMAGED',
      customerReturn: source._id,
      remarks: `From customer return ${source.returnNumber}`,
    });
  }

  if (rtvLines.length === 0) {
    throw new DomainError(
      'No units on that return were dispositioned RETURN_TO_VENDOR',
      'NOTHING_TO_RETURN',
    );
  }

  return createVendorReturn(actor, {
    vendor: payload.vendor,
    warehouse: source.warehouse,
    reason: payload.reason,
    reasonDetail: payload.reasonDetail ?? `Raised from ${source.returnNumber}`,
    expectReplacement: payload.expectReplacement ?? false,
    vendorRmaNumber: payload.vendorRmaNumber ?? null,
    lines: rtvLines,
  });
}

import { CustomerReturn } from '../../models/CustomerReturn.js';
import { VendorReturn } from '../../models/VendorReturn.js';
import { DispatchNote } from '../../models/DispatchNote.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { Customer } from '../../models/Customer.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { Warranty } from '../../models/Warranty.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement, moveBetweenBuckets } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { escapeRegex } from '../shared/crudFactory.js';
import {
  canMoveCustomerReturn, DISPOSITION_SERIAL_STATUS,
} from '../../constants/returns.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

const POPULATE = [
  { path: 'customer', select: 'customerName customerCode' },
  { path: 'warehouse', select: 'name code' },
  { path: 'dispatchNote', select: 'dispatchNoteNumber dispatchDate' },
  { path: 'lines.product', select: 'name sku productType' },
  { path: 'lines.serialNumbers', select: 'serialNumber status condition' },
  { path: 'lines.dispositions.serialNumbers', select: 'serialNumber status' },
  { path: 'lines.dispositions.vendorReturn', select: 'returnNumber status' },
  { path: 'approvedBy receivedBy createdBy', select: 'fullName' },
];

export async function listCustomerReturns(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.customer) filter.customer = query.customer;
  if (query.warehouse) filter.warehouse = query.warehouse;
  if (query.reason) filter.reason = query.reason;
  if (query.pendingDisposition) filter.status = 'RECEIVED';
  if (query.search) {
    filter.returnNumber = { $regex: escapeRegex(String(query.search).toUpperCase()), $options: 'i' };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    CustomerReturn.find(filter).sort({ requestedDate: -1 })
      .skip((page - 1) * limit).limit(limit)
      .populate('customer', 'customerName customerCode')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku'),
    CustomerReturn.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getCustomerReturn(actor, id) {
  const doc = await CustomerReturn.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate(POPULATE);
  if (!doc) throw new NotFoundError('Return not found');
  return doc;
}

/**
 * Raises the return request. No stock moves — the goods are still with the
 * customer, and may never actually be sent.
 */
export async function createCustomerReturn(actor, payload) {
  const customer = await Customer.findOne({
    _id: payload.customer, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!customer) throw new NotFoundError('Customer not found');

  const warehouse = await Warehouse.findOne({
    _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!warehouse) throw new NotFoundError('Warehouse not found');

  let dispatchNote = null;
  if (payload.dispatchNote) {
    dispatchNote = await DispatchNote.findOne({
      _id: payload.dispatchNote, tenantId: actor.tenantId, deletedAt: null,
    });
    if (!dispatchNote) throw new NotFoundError('Dispatch note not found');

    if (String(dispatchNote.customer) !== String(customer._id)) {
      throw new DomainError(
        'That dispatch note belongs to a different customer',
        'DISPATCH_CUSTOMER_MISMATCH',
      );
    }
  }

  const lines = [];
  for (const line of payload.lines) {
    const product = await Product.findOne({
      _id: line.product, tenantId: actor.tenantId, deletedAt: null,
    });
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);

    // When the source dispatch is known, a customer cannot return more of a
    // product than we actually shipped them on it.
    if (dispatchNote) {
      const shipped = dispatchNote.lines
        .filter((l) => String(l.product) === String(product._id))
        .reduce((sum, l) => sum + l.quantity, 0);

      if (shipped === 0) {
        throw new DomainError(
          `${product.name} was not on dispatch note ${dispatchNote.dispatchNoteNumber}`,
          'PRODUCT_NOT_DISPATCHED',
        );
      }
      if (line.requestedQuantity > shipped) {
        throw new DomainError(
          `Cannot return ${line.requestedQuantity} of ${product.name}; only ${shipped} were dispatched`,
          'RETURN_EXCEEDS_DISPATCHED',
        );
      }
    }

    lines.push({
      product: product._id,
      requestedQuantity: line.requestedQuantity,
      reportedCondition: line.reportedCondition ?? null,
      remarks: line.remarks ?? null,
    });
  }

  const returnNumber = await nextDocumentNumber('RET');

  const doc = await CustomerReturn.create({
    tenantId: actor.tenantId,
    returnNumber,
    customer: customer._id,
    warehouse: warehouse._id,
    dispatchNote: dispatchNote?._id ?? null,
    reason: payload.reason,
    reasonDetail: payload.reasonDetail ?? null,
    lines,
    requestedDate: payload.requestedDate ?? new Date(),
    status: 'DRAFT',
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'CUSTOMER_RETURN_RAISED', module: 'CustomerReturn', recordId: doc._id,
    recordLabel: doc.returnNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    metadata: { customer: customer.customerCode, reason: payload.reason },
  });

  return getCustomerReturn(actor, doc._id);
}

/** Moves the request through its workflow. Approval is a human decision. */
export async function setCustomerReturnStatus(actor, id, { status, reason }) {
  const doc = await CustomerReturn.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!doc) throw new NotFoundError('Return not found');

  if (!canMoveCustomerReturn(doc.status, status)) {
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
    if (doc.pendingDispositionQuantity > 0) {
      // Closing with undecided stock would strand it in the DAMAGED bucket
      // with no open document explaining why it is there.
      throw new DomainError(
        `${doc.pendingDispositionQuantity} unit(s) still await a disposition`,
        'DISPOSITION_PENDING',
      );
    }
    doc.closedAt = new Date();
  }

  await doc.save();

  await writeAudit({
    action: `CUSTOMER_RETURN_${status}`, module: 'CustomerReturn', recordId: doc._id,
    recordLabel: doc.returnNumber, severity: status === 'APPROVED' ? 'CRITICAL' : 'NOTICE',
    tenantId: actor.tenantId,
    changes: [{ field: 'status', before: from, after: status }],
    metadata: { reason: reason ?? null },
  });

  if (status === 'APPROVED') {
    await notify({
      tenantId: actor.tenantId,
      type: 'CUSTOMER_RETURN_APPROVED',
      title: `Return ${doc.returnNumber} approved — expect goods inbound`,
      body: `${doc.lines.length} line(s) authorised for return`,
      severity: 'NOTICE',
      recipientPermission: 'CREATE_GRN',
      module: 'CustomerReturn',
      recordId: doc._id,
      actionUrl: '/customer-returns',
      dedupeKey: `CUSTOMER_RETURN_APPROVED:${doc._id}`,
    });
  }

  return getCustomerReturn(actor, doc._id);
}

/**
 * The goods physically arrive.
 *
 * They enter the DAMAGED bucket, NOT available. Condition is unknown until
 * somebody opens the box, and the cost of guessing wrong is dispatching a
 * faulty unit to the next customer. Quarantine is the safe direction to fail.
 *
 * Serials move DISPATCHED → RETURNED_BY_CUSTOMER, which the transition table
 * allows only from DISPATCHED — so a unit we never sent cannot be "returned".
 */
export async function receiveCustomerReturn(actor, id, payload, { idempotencyKey } = {}) {
  if (idempotencyKey) {
    const existing = await CustomerReturn.findOne({
      tenantId: actor.tenantId, idempotencyKey,
    });
    if (existing) return getCustomerReturn(actor, existing._id);
  }

  const returnId = await withTransaction(async ({ session, onCommit }) => {
    const doc = await CustomerReturn.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!doc) throw new NotFoundError('Return not found');

    if (doc.status !== 'APPROVED') {
      throw new DomainError(
        'Only an approved return may be received. A box nobody authorised should not enter stock.',
        'RETURN_NOT_APPROVED',
      );
    }
    if (doc.receivedAt) {
      throw new ConflictError('This return has already been received', 'ALREADY_RECEIVED');
    }

    const voidedWarranties = [];

    for (const received of payload.lines) {
      const line = doc.lines.id(received.lineId);
      if (!line) throw new NotFoundError(`Line ${received.lineId} not found on this return`);

      if (received.receivedQuantity > line.requestedQuantity) {
        throw new DomainError(
          `Received ${received.receivedQuantity} but only ${line.requestedQuantity} were authorised`,
          'RECEIPT_EXCEEDS_AUTHORISED',
        );
      }
      if (received.receivedQuantity === 0) continue;

      const product = await Product.findById(line.product).session(session);
      const serials = received.serialNumbers ?? [];

      if (product.productType === 'SERIALIZED') {
        if (serials.length !== received.receivedQuantity) {
          throw new DomainError(
            `${product.name} is serialized: ${received.receivedQuantity} serial number(s) required`,
            'SERIAL_COUNT_MISMATCH',
          );
        }
      }

      // Bulk stock: one movement for the whole quantity.
      if (serials.length === 0) {
        await applyMovement({
          session, actor,
          product: line.product, warehouse: doc.warehouse,
          bucket: 'DAMAGED', quantityChange: received.receivedQuantity,
          transactionType: 'CUSTOMER_RETURN',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          remarks: `Returned by customer — awaiting inspection`,
        });
      }

      for (const serialNumber of serials) {
        const serial = await SerialNumber.findOne({
          tenantId: actor.tenantId, serialNumber: String(serialNumber).trim().toUpperCase(),
        }).session(session);

        if (!serial) {
          throw new NotFoundError(`No unit found with serial number ${serialNumber}`, 'SERIAL_NOT_FOUND');
        }
        if (String(serial.product) !== String(line.product)) {
          throw new DomainError(
            `${serial.serialNumber} is not a ${product.name}`,
            'SERIAL_PRODUCT_MISMATCH',
          );
        }
        if (serial.customer && String(serial.customer) !== String(doc.customer)) {
          throw new DomainError(
            `${serial.serialNumber} was issued to a different customer`,
            'SERIAL_CUSTOMER_MISMATCH',
          );
        }

        await applyMovement({
          session, actor,
          product: line.product, warehouse: doc.warehouse,
          bucket: 'DAMAGED', quantityChange: 1,
          transactionType: 'CUSTOMER_RETURN',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          serialNumber: serial._id,
          remarks: 'Returned by customer — awaiting inspection',
        });

        await serialService.transition({
          session, actor, serial, toStatus: 'RETURNED_BY_CUSTOMER',
          eventType: 'RETURNED_BY_CUSTOMER',
          referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
          warehouse: doc.warehouse, customer: null,
          remarks: received.condition ?? null,
        });

        // The customer no longer holds the unit, so the cover on it ends.
        // Recorded against this return so it never looks like an unexplained
        // void sitting on the warranty.
        if (serial.currentWarranty) {
          const warranty = await Warranty.findOne({
            _id: serial.currentWarranty, tenantId: actor.tenantId, state: 'ACTIVE',
          }).session(session);

          if (warranty) {
            warranty.state = 'VOID';
            warranty.voidReason = `Unit returned by customer on ${doc.returnNumber}`;
            await warranty.save({ session });
            voidedWarranties.push(warranty._id);
          }
        }

        line.serialNumbers.push(serial._id);
      }

      line.receivedQuantity = received.receivedQuantity;
    }

    doc.status = 'RECEIVED';
    doc.receivedAt = new Date();
    doc.receivedBy = actor.id;
    doc.warrantiesVoided = voidedWarranties;
    if (idempotencyKey) doc.idempotencyKey = idempotencyKey;
    await doc.save({ session });

    onCommit(() => writeAudit({
      action: 'CUSTOMER_RETURN_RECEIVED', module: 'CustomerReturn', recordId: doc._id,
      recordLabel: doc.returnNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        warrantiesVoided: voidedWarranties.length,
        quantity: doc.lines.reduce((s, l) => s + l.receivedQuantity, 0),
      },
    }));

    onCommit(() => notify({
      tenantId: actor.tenantId,
      type: 'RETURN_AWAITING_DISPOSITION',
      title: `${doc.returnNumber} received — ${doc.pendingDispositionQuantity} unit(s) to inspect`,
      body: 'Returned stock is quarantined until a disposition is set',
      severity: 'NOTICE',
      recipientPermission: 'SET_DISPOSITION',
      module: 'CustomerReturn',
      recordId: doc._id,
      actionUrl: '/customer-returns',
      dedupeKey: `RETURN_AWAITING_DISPOSITION:${doc._id}`,
    }));

    return doc._id;
  });

  return getCustomerReturn(actor, returnId);
}

/**
 * The inspection decision — what actually happens to the goods.
 *
 * Each disposition is a ledger movement out of quarantine. RESTOCK moves
 * DAMAGED → AVAILABLE and the unit is sellable again; SCRAP and
 * RETURN_TO_VENDOR take it out of stock entirely; QUARANTINE leaves it where
 * it is but records that a human looked.
 */
export async function setDisposition(actor, id, payload) {
  const returnId = await withTransaction(async ({ session, onCommit }) => {
    const doc = await CustomerReturn.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!doc) throw new NotFoundError('Return not found');

    if (doc.status !== 'RECEIVED') {
      throw new DomainError(
        'Goods must be received before a disposition can be set',
        'RETURN_NOT_RECEIVED',
      );
    }

    const line = doc.lines.id(payload.lineId);
    if (!line) throw new NotFoundError('Line not found on this return');

    const alreadyDecided = (line.dispositions ?? []).reduce((s, d) => s + d.quantity, 0);
    const remaining = line.receivedQuantity - alreadyDecided;

    if (payload.quantity > remaining) {
      throw new DomainError(
        `Only ${remaining} unit(s) of this line await a disposition`,
        'DISPOSITION_EXCEEDS_PENDING',
      );
    }

    const serials = payload.serialNumbers ?? [];
    const product = await Product.findById(line.product).session(session);

    if (product.productType === 'SERIALIZED' && serials.length !== payload.quantity) {
      throw new DomainError(
        `${product.name} is serialized: name the ${payload.quantity} unit(s) being dispositioned`,
        'SERIAL_COUNT_MISMATCH',
      );
    }

    const serialDocs = [];
    for (const serialNumber of serials) {
      const serial = await SerialNumber.findOne({
        tenantId: actor.tenantId, serialNumber: String(serialNumber).trim().toUpperCase(),
      }).session(session);
      if (!serial) throw new NotFoundError(`No unit found with serial ${serialNumber}`);

      if (!line.serialNumbers.some((s) => String(s) === String(serial._id))) {
        throw new DomainError(
          `${serial.serialNumber} did not arrive on this return line`,
          'SERIAL_NOT_ON_RETURN',
        );
      }
      serialDocs.push(serial);
    }

    const toStatus = DISPOSITION_SERIAL_STATUS[payload.disposition];

    // RESTOCK is the only disposition that returns goods to sellable stock.
    if (payload.disposition === 'RESTOCK') {
      await moveBetweenBuckets({
        session, actor,
        product: line.product, warehouse: doc.warehouse,
        fromBucket: 'DAMAGED', toBucket: 'AVAILABLE', quantity: payload.quantity,
        transactionType: 'STOCK_ADJUSTMENT',
        referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
        reasonCode: 'DATA_CORRECTION',
        remarks: `Inspected and restocked from ${doc.returnNumber}`,
      });
    }

    // SCRAP is the only disposition here that takes goods out of stock.
    //
    // RETURN_TO_VENDOR does NOT: the unit is still in our building until the
    // vendor return is approved and shipped, so it stays in quarantine and
    // `sendVendorReturn` moves it. Taking it out here would leave the quantity
    // sitting in DAMAGED while the serial claimed to have left — drift we
    // created ourselves, reported every night by the reconciliation job.
    if (payload.disposition === 'SCRAP') {
      await applyMovement({
        session, actor,
        product: line.product, warehouse: doc.warehouse,
        bucket: 'DAMAGED', quantityChange: -payload.quantity,
        transactionType: 'SCRAP',
        referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
        reasonCode: 'DAMAGE',
        remarks: payload.inspectionNotes ?? `Scrapped from ${doc.returnNumber}`,
      });
    }

    for (const serial of serialDocs) {
      await serialService.transition({
        session, actor, serial, toStatus,
        eventType: `DISPOSITION_${payload.disposition}`,
        referenceType: 'RETURN', referenceId: doc._id, referenceNumber: doc.returnNumber,
        // A scrapped unit has no location; everything else stays where it is.
        warehouse: toStatus === 'SCRAPPED' ? null : doc.warehouse,
        remarks: payload.inspectionNotes ?? null,
        extra: payload.disposition === 'RESTOCK' ? { condition: 'REFURBISHED' } : {},
      });
    }

    line.dispositions.push({
      disposition: payload.disposition,
      quantity: payload.quantity,
      serialNumbers: serialDocs.map((s) => s._id),
      inspectionNotes: payload.inspectionNotes ?? null,
      decidedBy: actor.id,
      decidedAt: new Date(),
    });

    await doc.save({ session });

    onCommit(() => writeAudit({
      action: 'RETURN_DISPOSITION_SET', module: 'CustomerReturn', recordId: doc._id,
      recordLabel: doc.returnNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        disposition: payload.disposition,
        quantity: payload.quantity,
        serials: serialDocs.map((s) => s.serialNumber),
      },
    }));

    return doc._id;
  });

  return getCustomerReturn(actor, returnId);
}

/** Returned units awaiting a decision — the inspection queue. */
export async function dispositionQueue(actor) {
  const docs = await CustomerReturn.find({
    tenantId: actor.tenantId, status: 'RECEIVED', deletedAt: null,
  })
    .populate('customer', 'customerName')
    .populate('warehouse', 'name code')
    .populate('lines.product', 'name sku')
    .sort({ receivedAt: 1 });

  return docs
    .map((doc) => ({ doc, pending: doc.pendingDispositionQuantity }))
    .filter(({ pending }) => pending > 0);
}

/** Every return a unit has ever been part of. */
export async function serialReturnHistory(actor, serialId) {
  const [customerReturns, vendorReturns] = await Promise.all([
    CustomerReturn.find({ tenantId: actor.tenantId, 'lines.serialNumbers': serialId })
      .select('returnNumber status reason requestedDate receivedAt')
      .sort({ requestedDate: -1 }),
    VendorReturn.find({ tenantId: actor.tenantId, 'lines.serialNumbers': serialId })
      .select('returnNumber status reason sentAt')
      .populate('vendor', 'vendorName')
      .sort({ createdAt: -1 }),
  ]);

  return { customerReturns, vendorReturns };
}

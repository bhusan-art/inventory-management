import { ServiceRequest, canMoveService } from '../../models/ServiceRequest.js';
import { Warranty } from '../../models/Warranty.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { Customer } from '../../models/Customer.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { User } from '../../models/User.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { escapeRegex } from '../shared/crudFactory.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { warrantyStatus } from '../../utils/dates.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

const SLA_HOURS = { CRITICAL: 4, HIGH: 24, MEDIUM: 72, LOW: 168 };

export async function listServiceRequests(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.customer) filter.customer = query.customer;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;
  if (query.openOnly) filter.status = { $nin: ['CLOSED', 'REJECTED'] };
  if (query.search) {
    filter.ticketNumber = { $regex: escapeRegex(String(query.search).toUpperCase()), $options: 'i' };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    ServiceRequest.find(filter).sort({ priority: 1, reportedDate: -1 })
      .skip((page - 1) * limit).limit(limit)
      .populate('customer', 'customerName customerCode')
      .populate('product', 'name sku')
      .populate('serialNumber', 'serialNumber status')
      .populate('assignedTo', 'fullName'),
    ServiceRequest.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getServiceRequest(actor, id) {
  const ticket = await ServiceRequest.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('customer', 'customerName customerCode')
    .populate('product', 'name sku warrantyMonths')
    .populate('serialNumber', 'serialNumber status warehouse')
    .populate('replacementSerialNumber', 'serialNumber')
    .populate('warranty')
    .populate('assignedTo closedBy', 'fullName')
    .populate('vendor', 'vendorName vendorCode')
    .populate('activity.performedBy', 'fullName');

  if (!ticket) throw new NotFoundError('Service request not found');
  return ticket;
}

/**
 * Raises a ticket.
 *
 * The entitlement decision happens HERE and is frozen. A warranty can expire
 * while a unit sits in the workshop; the customer reported the fault while
 * covered, so the repair stays covered. Deciding at closing time would charge
 * people for the queue they waited in.
 */
export async function createServiceRequest(actor, payload) {
  const serial = payload.serialNumber
    ? await SerialNumber.findOne({
        tenantId: actor.tenantId,
        serialNumber: String(payload.serialNumber).trim().toUpperCase(),
      }).populate('product')
    : null;

  if (payload.serialNumber && !serial) {
    throw new NotFoundError(`No unit found with serial number ${payload.serialNumber}`, 'SERIAL_NOT_FOUND');
  }

  const customerId = payload.customer ?? serial?.customer;
  if (!customerId) {
    throw new DomainError(
      'A customer is required — this unit is not assigned to one',
      'CUSTOMER_REQUIRED',
    );
  }

  const customer = await Customer.findOne({ _id: customerId, tenantId: actor.tenantId, deletedAt: null });
  if (!customer) throw new NotFoundError('Customer not found');

  if (serial && serial.customer && String(serial.customer) !== String(customer._id)) {
    throw new DomainError(
      `${serial.serialNumber} belongs to a different customer`,
      'SERIAL_CUSTOMER_MISMATCH',
    );
  }

  const productId = payload.product ?? serial?.product?._id ?? serial?.product;
  const product = await Product.findOne({ _id: productId, tenantId: actor.tenantId, deletedAt: null });
  if (!product) throw new NotFoundError('Product not found');

  const warranty = serial
    ? await Warranty.findOne({ tenantId: actor.tenantId, serialNumber: serial._id, state: 'ACTIVE' })
        .sort({ endDate: -1 })
    : null;

  const reportedDate = payload.reportedDate ? new Date(payload.reportedDate) : new Date();
  const status = warranty ? warrantyStatus(warranty, reportedDate) : null;
  const warrantyApplicable = status === 'ACTIVE' || status === 'EXPIRING_SOON';

  const priority = payload.priority ?? 'MEDIUM';
  const ticketNumber = await nextDocumentNumber('SR');

  const ticket = await ServiceRequest.create({
    tenantId: actor.tenantId,
    ticketNumber,
    customer: customer._id,
    product: product._id,
    serialNumber: serial?._id ?? null,
    warranty: warranty?._id ?? null,
    warrantyApplicable,
    warrantyEndDateAtRaise: warranty?.endDate ?? null,
    issueDescription: payload.issueDescription,
    reportedDate,
    priority,
    slaDueDate: new Date(reportedDate.getTime() + SLA_HOURS[priority] * 3_600_000),
    status: 'OPEN',
    activity: [{ toStatus: 'OPEN', note: 'Ticket raised', performedBy: actor.id }],
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'SERVICE_REQUEST_RAISED', module: 'ServiceRequest', recordId: ticket._id,
    recordLabel: ticket.ticketNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    metadata: { warrantyApplicable, priority, serial: serial?.serialNumber ?? null },
  });

  await notify({
    tenantId: actor.tenantId,
    type: 'SERVICE_REQUEST_RAISED',
    title: `${priority} service ticket ${ticket.ticketNumber} raised`,
    body: `${customer.customerName} — ${product.name}${serial ? ` (${serial.serialNumber})` : ''}`,
    severity: priority === 'CRITICAL' ? 'WARNING' : 'NOTICE',
    recipientPermission: 'ASSIGN_SERVICE_REQUEST',
    module: 'ServiceRequest',
    recordId: ticket._id,
    actionUrl: '/service-requests',
    dedupeKey: `SERVICE_RAISED:${ticket._id}`,
  });

  return getServiceRequest(actor, ticket._id);
}

export async function assignServiceRequest(actor, id, { assignedTo, priority }) {
  const ticket = await ServiceRequest.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!ticket) throw new NotFoundError('Service request not found');
  if (['CLOSED', 'REJECTED'].includes(ticket.status)) {
    throw new DomainError('A closed ticket cannot be reassigned', 'TICKET_CLOSED');
  }

  if (assignedTo) {
    const engineer = await User.findOne({ _id: assignedTo, tenantId: actor.tenantId, deletedAt: null });
    if (!engineer) throw new NotFoundError('User not found');
    ticket.assignedTo = engineer._id;
  }

  if (priority && priority !== ticket.priority) {
    ticket.priority = priority;
    // Re-base the SLA from the original report, not from now: raising the
    // priority of a day-old ticket should not hand it a fresh clock.
    ticket.slaDueDate = new Date(ticket.reportedDate.getTime() + SLA_HOURS[priority] * 3_600_000);
  }

  ticket.activity.push({
    fromStatus: ticket.status, toStatus: ticket.status,
    note: `Assigned${priority ? ` · priority ${priority}` : ''}`,
    performedBy: actor.id,
  });
  await ticket.save();

  await writeAudit({
    action: 'SERVICE_REQUEST_ASSIGNED', module: 'ServiceRequest', recordId: ticket._id,
    recordLabel: ticket.ticketNumber, severity: 'INFO', tenantId: actor.tenantId,
  });

  return getServiceRequest(actor, ticket._id);
}

/**
 * The faulty unit physically arrives at a service location.
 *
 * It enters OUR stock in the UNDER_SERVICE bucket — it is in our building and
 * must be countable — while remaining the customer's property. Serial moves
 * DISPATCHED → UNDER_SERVICE.
 *
 * Note the transaction type: SERVICE_OUT means "out of the customer's hands
 * and into service", so it is an IN movement for us. The names are read from
 * the unit's point of view, not the warehouse's.
 */
export async function receiveForService(actor, id, { warehouse: warehouseId, note }) {
  const ticketId = await withTransaction(async ({ session, onCommit }) => {
    const ticket = await ServiceRequest.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!ticket) throw new NotFoundError('Service request not found');

    if (ticket.receivedAt) {
      throw new ConflictError('This unit has already been received for service', 'ALREADY_RECEIVED');
    }
    if (!ticket.serialNumber) {
      throw new DomainError('Only a serialized unit can be received for service', 'NOT_SERIALIZED');
    }

    const warehouse = await Warehouse.findOne({
      _id: warehouseId, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!warehouse) throw new NotFoundError('Warehouse not found');

    const serial = await SerialNumber.findOne({
      _id: ticket.serialNumber, tenantId: actor.tenantId,
    }).session(session);

    await applyMovement({
      session, actor,
      product: ticket.product, warehouse: warehouse._id,
      bucket: 'UNDER_SERVICE', quantityChange: 1,
      transactionType: 'SERVICE_OUT',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      serialNumber: serial._id,
      remarks: 'Received from customer for service',
    });

    await serialService.transition({
      session, actor, serial, toStatus: 'UNDER_SERVICE', eventType: 'RECEIVED_FOR_SERVICE',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      warehouse: warehouse._id, remarks: note,
    });

    ticket.receivedAtWarehouse = warehouse._id;
    ticket.receivedAt = new Date();
    if (ticket.status === 'OPEN') ticket.status = 'UNDER_INSPECTION';
    ticket.activity.push({
      fromStatus: 'OPEN', toStatus: ticket.status,
      note: note ?? `Unit received at ${warehouse.code}`, performedBy: actor.id,
    });
    await ticket.save({ session });

    onCommit(() => writeAudit({
      action: 'SERVICE_UNIT_RECEIVED', module: 'ServiceRequest', recordId: ticket._id,
      recordLabel: ticket.ticketNumber, severity: 'NOTICE', tenantId: actor.tenantId,
      metadata: { warehouse: warehouse.code },
    }));

    return ticket._id;
  });

  return getServiceRequest(actor, ticketId);
}

/** Moves the ticket through its workflow, with the transition table enforced. */
export async function updateStatus(actor, id, { status, note, vendor, vendorRmaNumber, rootCause }) {
  const ticket = await ServiceRequest.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!ticket) throw new NotFoundError('Service request not found');

  if (!canMoveService(ticket.status, status)) {
    throw new DomainError(
      `A ticket cannot move from ${ticket.status} to ${status}`,
      'INVALID_STATE_TRANSITION',
      [{ code: 'INVALID_STATE_TRANSITION', from: ticket.status, to: status }],
    );
  }

  if (status === 'SENT_TO_VENDOR' && !vendor) {
    throw new DomainError('A vendor is required when sending a unit out for repair', 'VENDOR_REQUIRED');
  }

  const from = ticket.status;
  ticket.status = status;
  if (vendor) ticket.vendor = vendor;
  if (vendorRmaNumber) ticket.vendorRmaNumber = vendorRmaNumber;
  if (rootCause) ticket.rootCause = rootCause;
  ticket.activity.push({ fromStatus: from, toStatus: status, note, performedBy: actor.id });
  await ticket.save();

  await writeAudit({
    action: 'SERVICE_REQUEST_STATUS_CHANGED', module: 'ServiceRequest', recordId: ticket._id,
    recordLabel: ticket.ticketNumber, severity: 'INFO', tenantId: actor.tenantId,
    changes: [{ field: 'status', before: from, after: status }],
  });

  return getServiceRequest(actor, ticket._id);
}

/**
 * The repaired unit goes back to the customer.
 *
 * Leaves our UNDER_SERVICE bucket and returns to DISPATCHED. The warranty is
 * untouched — a repair does not extend cover.
 */
export async function returnRepairedUnit(actor, id, { resolution }) {
  const ticketId = await withTransaction(async ({ session, onCommit }) => {
    const ticket = await ServiceRequest.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!ticket) throw new NotFoundError('Service request not found');

    if (ticket.status !== 'REPAIRED') {
      throw new DomainError('Only a repaired unit can be returned to the customer', 'NOT_REPAIRED');
    }
    if (!ticket.receivedAt) {
      throw new DomainError('This unit was never received for service', 'NOT_RECEIVED');
    }
    if (ticket.returnedAt) {
      throw new ConflictError('This unit has already been returned', 'ALREADY_RETURNED');
    }

    const serial = await SerialNumber.findOne({
      _id: ticket.serialNumber, tenantId: actor.tenantId,
    }).session(session);

    await applyMovement({
      session, actor,
      product: ticket.product, warehouse: ticket.receivedAtWarehouse,
      bucket: 'UNDER_SERVICE', quantityChange: -1,
      transactionType: 'SERVICE_RETURN',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      serialNumber: serial._id,
      remarks: 'Returned to customer after repair',
    });

    await serialService.transition({
      session, actor, serial, toStatus: 'DISPATCHED', eventType: 'RETURNED_AFTER_REPAIR',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      warehouse: null, customer: ticket.customer,
      extra: { condition: 'REFURBISHED' },
    });

    ticket.returnedAt = new Date();
    ticket.resolution = resolution;
    ticket.status = 'CLOSED';
    ticket.closedAt = new Date();
    ticket.closedBy = actor.id;
    ticket.activity.push({ fromStatus: 'REPAIRED', toStatus: 'CLOSED', note: resolution, performedBy: actor.id });
    await ticket.save({ session });

    onCommit(() => writeAudit({
      action: 'SERVICE_UNIT_RETURNED', module: 'ServiceRequest', recordId: ticket._id,
      recordLabel: ticket.ticketNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    }));

    return ticket._id;
  });

  return getServiceRequest(actor, ticketId);
}

/**
 * REPLACEMENT — the most intricate operation in the system.
 *
 * A new unit goes to the customer and the faulty one leaves stock. Five things
 * move together:
 *
 *   1. replacement: AVAILABLE → DISPATCHED, customer assigned, stock out
 *   2. faulty unit: UNDER_SERVICE → REPLACED, leaves stock
 *   3. original warranty: state CLAIMED_REPLACED
 *   4. new warranty on the replacement, carrying the ORIGINAL end date
 *   5. the two serials linked so the asset history reads continuously
 *
 * Point 4 is the one people get wrong. A replacement does not restart the
 * clock: a customer who buys three years of cover and receives a replacement in
 * month 30 is entitled to six more months, not thirty-six. Restarting it would
 * quietly hand out free cover on every claim.
 */
export async function replaceUnit(actor, id, { replacementSerialNumber, warehouse: warehouseId, resolution }) {
  const ticketId = await withTransaction(async ({ session, onCommit }) => {
    const ticket = await ServiceRequest.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);
    if (!ticket) throw new NotFoundError('Service request not found');

    if (!canMoveService(ticket.status, 'REPLACED')) {
      throw new DomainError(`A ${ticket.status} ticket cannot be resolved by replacement`, 'INVALID_STATE_TRANSITION');
    }
    if (!ticket.serialNumber) {
      throw new DomainError('Only a serialized unit can be replaced', 'NOT_SERIALIZED');
    }

    const faulty = await SerialNumber.findOne({
      _id: ticket.serialNumber, tenantId: actor.tenantId,
    }).session(session);

    const replacement = await SerialNumber.findOne({
      tenantId: actor.tenantId,
      serialNumber: String(replacementSerialNumber).trim().toUpperCase(),
    }).session(session);

    if (!replacement) throw new NotFoundError(`No unit found with serial ${replacementSerialNumber}`);
    if (String(replacement.product) !== String(ticket.product)) {
      throw new DomainError('The replacement must be the same product', 'PRODUCT_MISMATCH');
    }
    if (replacement.status !== 'AVAILABLE') {
      throw new DomainError(
        `${replacement.serialNumber} is ${replacement.status.toLowerCase().replace('_', ' ')} and cannot be issued`,
        'REPLACEMENT_NOT_AVAILABLE',
      );
    }

    const sourceWarehouse = warehouseId ?? replacement.warehouse;

    // 1. The replacement leaves stock for the customer.
    await applyMovement({
      session, actor,
      product: ticket.product, warehouse: sourceWarehouse,
      bucket: 'AVAILABLE', quantityChange: -1,
      transactionType: 'REPLACEMENT',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      serialNumber: replacement._id,
      remarks: `Replacement issued for ${faulty.serialNumber}`,
    });

    await serialService.transition({
      session, actor, serial: replacement, toStatus: 'RESERVED', eventType: 'REPLACEMENT_ALLOCATED',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
    });
    await serialService.transition({
      session, actor, serial: replacement, toStatus: 'DISPATCHED', eventType: 'REPLACEMENT_ISSUED',
      referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
      warehouse: null, customer: ticket.customer,
      extra: { dispatchDate: new Date() },
    });

    // 2. The faulty unit leaves stock if it was ever received.
    if (ticket.receivedAt) {
      await applyMovement({
        session, actor,
        product: ticket.product, warehouse: ticket.receivedAtWarehouse,
        bucket: 'UNDER_SERVICE', quantityChange: -1,
        transactionType: 'REPLACEMENT',
        referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
        serialNumber: faulty._id,
        remarks: 'Faulty unit replaced',
      });
      await serialService.transition({
        session, actor, serial: faulty, toStatus: 'REPLACED', eventType: 'REPLACED_UNDER_WARRANTY',
        referenceType: 'SERVICE', referenceId: ticket._id, referenceNumber: ticket.ticketNumber,
        warehouse: null, customer: null,
      });
    }

    // 3 & 4. Cover follows the replacement, keeping the original end date.
    const original = ticket.warranty
      ? await Warranty.findOne({ _id: ticket.warranty, tenantId: actor.tenantId }).session(session)
      : null;

    let newWarranty = null;
    if (original) {
      original.state = 'CLAIMED_REPLACED';
      await original.save({ session });

      const warrantyNumber = await nextDocumentNumber('WTY', { session });
      [newWarranty] = await Warranty.create([{
        tenantId: actor.tenantId,
        warrantyNumber,
        product: ticket.product,
        serialNumber: replacement._id,
        customer: ticket.customer,
        dispatchNote: original.dispatchNote,
        dispatchDate: new Date(),
        startDate: new Date(),
        // The original expiry, not a fresh term.
        endDate: original.endDate,
        durationMonths: original.durationMonths,
        provider: original.provider,
        terms: original.terms,
        state: 'ACTIVE',
        previousWarranty: original._id,
        createdBy: actor.id,
      }], { session, ordered: true });

      replacement.currentWarranty = newWarranty._id;
      await replacement.save({ session });
    }

    // 5. Link the two so the asset history reads continuously across the swap.
    ticket.replacementSerialNumber = replacement._id;
    ticket.status = 'REPLACED';
    ticket.resolution = resolution;
    ticket.returnedAt = new Date();
    ticket.activity.push({
      fromStatus: ticket.activity.at(-1)?.toStatus ?? 'UNDER_REPAIR',
      toStatus: 'REPLACED',
      note: `${faulty.serialNumber} replaced by ${replacement.serialNumber}. ${resolution ?? ''}`.trim(),
      performedBy: actor.id,
    });
    await ticket.save({ session });

    onCommit(() => writeAudit({
      action: 'SERVICE_UNIT_REPLACED', module: 'ServiceRequest', recordId: ticket._id,
      recordLabel: ticket.ticketNumber, severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        faulty: faulty.serialNumber,
        replacement: replacement.serialNumber,
        warrantyEndDateCarriedOver: original?.endDate ?? null,
      },
    }));

    return ticket._id;
  });

  return getServiceRequest(actor, ticketId);
}

export async function closeServiceRequest(actor, id, { resolution }) {
  const ticket = await ServiceRequest.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!ticket) throw new NotFoundError('Service request not found');

  if (!canMoveService(ticket.status, 'CLOSED')) {
    throw new DomainError(`A ${ticket.status} ticket cannot be closed directly`, 'INVALID_STATE_TRANSITION');
  }
  if (ticket.receivedAt && !ticket.returnedAt && ticket.status !== 'REJECTED') {
    // Closing while we still physically hold the unit would strand it in the
    // UNDER_SERVICE bucket with no open ticket explaining why.
    throw new DomainError(
      'This unit is still at the service centre. Return or replace it before closing.',
      'UNIT_STILL_HELD',
    );
  }

  const from = ticket.status;
  ticket.status = 'CLOSED';
  ticket.resolution = resolution ?? ticket.resolution;
  ticket.closedAt = new Date();
  ticket.closedBy = actor.id;
  ticket.activity.push({ fromStatus: from, toStatus: 'CLOSED', note: resolution, performedBy: actor.id });
  await ticket.save();

  await writeAudit({
    action: 'SERVICE_REQUEST_CLOSED', module: 'ServiceRequest', recordId: ticket._id,
    recordLabel: ticket.ticketNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getServiceRequest(actor, ticket._id);
}

/** Every ticket a unit has ever had — the service half of its history. */
export async function serialServiceHistory(actor, serialId) {
  return ServiceRequest.find({
    tenantId: actor.tenantId,
    $or: [{ serialNumber: serialId }, { replacementSerialNumber: serialId }],
  }).sort({ reportedDate: -1 })
    .populate('assignedTo', 'fullName')
    .populate('replacementSerialNumber', 'serialNumber');
}

export { SLA_HOURS };

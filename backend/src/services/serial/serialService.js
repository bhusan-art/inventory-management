import { SerialNumber, SerialNumberEvent } from '../../models/SerialNumber.js';
import { canTransition, STATUS_BUCKET } from '../../constants/inventory.js';
import { applyMovement, moveBetweenBuckets } from '../inventory/ledgerService.js';
import { withTransaction } from '../shared/transaction.js';
import { writeAudit } from '../shared/auditService.js';
import { DomainError, ConflictError, NotFoundError } from '../../utils/errors.js';

/**
 * Serial number state machine.
 *
 * Every status change goes through `transition`, which checks the table in
 * constants/inventory.js and appends a history event. There is no other way to
 * write `status` — the same reasoning as the ledger service: make the rule
 * structural rather than remembered.
 */
export async function transition({
  session, actor, serial, toStatus, eventType,
  referenceType = null, referenceId = null, referenceNumber = null,
  warehouse, customer, remarks = null, extra = {},
}) {
  if (!session) throw new Error('Serial transitions require a transaction session');

  const fromStatus = serial.status;

  if (!canTransition(fromStatus, toStatus)) {
    throw new DomainError(
      `A serial number cannot move from ${fromStatus} to ${toStatus}`,
      'INVALID_STATE_TRANSITION',
      [{ code: 'INVALID_STATE_TRANSITION', serialNumber: serial.serialNumber, from: fromStatus, to: toStatus }],
    );
  }

  serial.status = toStatus;
  if (warehouse !== undefined) serial.warehouse = warehouse;
  if (customer !== undefined) serial.customer = customer;
  Object.assign(serial, extra);
  await serial.save({ session });

  await SerialNumberEvent.create([{
    tenantId: actor.tenantId,
    serialNumber: serial._id,
    fromStatus,
    toStatus,
    eventType,
    referenceType,
    referenceId,
    referenceNumber,
    warehouse: serial.warehouse,
    customer: serial.customer,
    performedBy: actor.id,
    remarks,
  }], { session });

  return serial;
}

/**
 * Creates serial records at GRN posting.
 *
 * Checks for existing serials in one query before writing anything. The unique
 * index is the real guarantee, but a duplicate-key error names one serial at a
 * time — receiving a pallet of 200 units with three duplicates should tell the
 * operator about all three at once, not make them retry three times.
 */
export async function createForReceipt({
  session, actor, product, warehouse, grn, vendor, serialNumbers,
  rackLocation = null, batchNumber = null, manufacturingDate = null, receivedDate,
}) {
  if (!session) throw new Error('Serial creation requires a transaction session');
  if (serialNumbers.length === 0) return [];

  const normalized = serialNumbers.map((s) => String(s).trim().toUpperCase());

  const duplicatesInBatch = normalized.filter((s, i) => normalized.indexOf(s) !== i);
  if (duplicatesInBatch.length > 0) {
    throw new ConflictError(
      `These serial numbers are repeated in this receipt: ${[...new Set(duplicatesInBatch)].join(', ')}`,
      'DUPLICATE_SERIAL',
      [...new Set(duplicatesInBatch)].map((s) => ({ code: 'DUPLICATE_SERIAL', serialNumber: s })),
    );
  }

  const existing = await SerialNumber.find({
    tenantId: actor.tenantId,
    serialNumber: { $in: normalized },
  }).select('serialNumber').session(session);

  if (existing.length > 0) {
    const taken = existing.map((e) => e.serialNumber);
    throw new ConflictError(
      `These serial numbers already exist: ${taken.join(', ')}`,
      'DUPLICATE_SERIAL',
      taken.map((s) => ({ code: 'DUPLICATE_SERIAL', serialNumber: s })),
    );
  }

  const docs = normalized.map((serialNumber) => ({
    tenantId: actor.tenantId,
    serialNumber,
    product,
    warehouse,
    grn,
    vendor,
    rackLocation,
    batchNumber,
    manufacturingDate,
    receivedDate,
    status: 'RECEIVED',
    condition: 'NEW',
  }));

  const created = await SerialNumber.create(docs, { session, ordered: true });

  await SerialNumberEvent.create(
    created.map((s) => ({
      tenantId: actor.tenantId,
      serialNumber: s._id,
      fromStatus: null,
      toStatus: 'RECEIVED',
      eventType: 'GRN_RECEIVED',
      referenceType: 'GRN',
      referenceId: grn,
      warehouse,
      performedBy: actor.id,
    })),
    { session },
  );

  return created;
}

/**
 * Manual status override — for genuine data corrections only.
 *
 * The important part is not the status change; it is that the QUANTITY MUST
 * MOVE WITH IT. Serialized stock has two representations that have to agree:
 * the number in `Inventory` and the number of serial records in the matching
 * status. Changing one without the other produces exactly the drift the
 * reconciliation job exists to find — and here it would be self-inflicted.
 *
 * So every override resolves both statuses to their buckets and moves the unit
 * between them in the same transaction as the status change.
 */
export async function overrideStatus(actor, id, { toStatus, reasonCode, remarks, warehouse }) {
  if (!remarks || remarks.trim().length < 10) {
    // The transition table says what is possible; only a human can say why.
    throw new DomainError(
      'A manual status override needs a written explanation of at least 10 characters',
      'REMARKS_REQUIRED',
      [{ code: 'REMARKS_REQUIRED', field: 'remarks' }],
    );
  }

  const serialId = await withTransaction(async ({ session, onCommit }) => {
    const serial = await SerialNumber.findOne({ _id: id, tenantId: actor.tenantId }).session(session);
    if (!serial) throw new NotFoundError('Serial number not found');

    const fromStatus = serial.status;
    const fromBucket = STATUS_BUCKET[fromStatus];
    const toBucket = STATUS_BUCKET[toStatus];

    // A unit that is not currently in a warehouse needs one naming before it
    // can re-enter stock.
    const targetWarehouse = warehouse ?? serial.warehouse;
    if (toBucket && !targetWarehouse) {
      throw new DomainError(
        'This unit is not in a warehouse. Name the warehouse it is entering.',
        'WAREHOUSE_REQUIRED',
        [{ code: 'WAREHOUSE_REQUIRED', field: 'warehouse' }],
      );
    }

    const ref = {
      transactionType: 'STOCK_ADJUSTMENT',
      referenceType: 'ADJUSTMENT',
      referenceId: serial._id,
      referenceNumber: serial.serialNumber,
      reasonCode,
      remarks,
      serialNumber: serial._id,
    };

    if (fromBucket && toBucket && fromBucket !== toBucket) {
      await moveBetweenBuckets({
        session, actor, product: serial.product, warehouse: serial.warehouse,
        fromBucket, toBucket, quantity: 1, ...ref,
      });
    } else if (fromBucket && !toBucket) {
      // Leaving stock entirely — scrapped, returned to vendor.
      await applyMovement({
        session, actor, product: serial.product, warehouse: serial.warehouse,
        bucket: fromBucket, quantityChange: -1, ...ref,
      });
    } else if (!fromBucket && toBucket) {
      await applyMovement({
        session, actor, product: serial.product, warehouse: targetWarehouse,
        bucket: toBucket, quantityChange: 1, ...ref,
      });
    }

    await transition({
      session, actor, serial, toStatus,
      eventType: 'MANUAL_OVERRIDE',
      referenceType: 'ADJUSTMENT',
      warehouse: toBucket ? targetWarehouse : null,
      remarks,
    });

    onCommit(() => writeAudit({
      action: 'SERIAL_STATUS_OVERRIDDEN',
      module: 'SerialNumber',
      recordId: serial._id,
      recordLabel: serial.serialNumber,
      // Overriding a lifecycle by hand is exactly the action an audit exists for.
      severity: 'CRITICAL',
      tenantId: actor.tenantId,
      changes: [{ field: 'status', before: fromStatus, after: toStatus }],
      metadata: { reasonCode, remarks, fromBucket, toBucket },
    }));

    return serial._id;
  });

  return SerialNumber.findById(serialId).populate('product warehouse customer');
}

/**
 * Updates identifiers and location notes — asset tag, MAC, IMEI, installation
 * site. Never touches status, so it needs no stock movement and no elevated
 * permission.
 */
export async function updateAttributes(actor, id, payload) {
  const serial = await SerialNumber.findOne({ _id: id, tenantId: actor.tenantId });
  if (!serial) throw new NotFoundError('Serial number not found');

  const before = serial.toObject();
  const fields = ['assetTag', 'macAddress', 'imei', 'installationLocation', 'rackLocation', 'remarks'];

  for (const field of fields) {
    if (payload[field] !== undefined) serial[field] = payload[field] || null;
  }

  // Sparse-unique indexes catch this at the database, but a clear message beats
  // a duplicate-key error naming an index.
  for (const field of ['assetTag', 'macAddress', 'imei']) {
    if (!serial[field]) continue;
    const clash = await SerialNumber.findOne({
      tenantId: actor.tenantId, [field]: serial[field], _id: { $ne: serial._id },
    }).select('serialNumber');
    if (clash) {
      throw new ConflictError(
        `${field} ${serial[field]} is already on serial ${clash.serialNumber}`,
        'DUPLICATE_IDENTIFIER',
        [{ code: 'DUPLICATE_IDENTIFIER', field }],
      );
    }
  }

  await serial.save();

  await writeAudit({
    action: 'SERIAL_ATTRIBUTES_UPDATED', module: 'SerialNumber', recordId: serial._id,
    recordLabel: serial.serialNumber, severity: 'NOTICE', tenantId: actor.tenantId,
    changes: fields
      .filter((f) => payload[f] !== undefined && before[f] !== serial[f])
      .map((f) => ({ field: f, before: before[f] ?? null, after: serial[f] ?? null })),
  });

  return serial.populate('product warehouse customer');
}

/** Validates entered serials against the product's format, when one is set. */
export function assertMatchesFormat(product, serialNumbers) {
  if (!product.serialFormatPattern || serialNumbers.length === 0) return;

  const pattern = new RegExp(product.serialFormatPattern);
  const bad = serialNumbers.filter((s) => !pattern.test(String(s).trim().toUpperCase()));

  if (bad.length > 0) {
    throw new DomainError(
      `These serial numbers do not match the expected format for ${product.name}: ${bad.join(', ')}`,
      'SERIAL_FORMAT_INVALID',
      bad.map((s) => ({ code: 'SERIAL_FORMAT_INVALID', serialNumber: s })),
    );
  }
}

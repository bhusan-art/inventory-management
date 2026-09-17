import { SerialNumber, SerialNumberEvent } from '../../models/SerialNumber.js';
import { canTransition } from '../../constants/inventory.js';
import { DomainError, ConflictError } from '../../utils/errors.js';

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

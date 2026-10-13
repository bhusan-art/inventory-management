import { SerialNumber, SerialNumberEvent } from '../../models/SerialNumber.js';
import { Inventory } from '../../models/Inventory.js';
import { InventoryTransaction } from '../../models/InventoryTransaction.js';
import { STATUS_BUCKET, SERIAL_TRANSITIONS } from '../../constants/inventory.js';
import { warehouseScopeFilter } from '../shared/scopeService.js';
import { NotFoundError } from '../../utils/errors.js';
import { escapeRegex } from '../shared/crudFactory.js';

export async function listSerials(actor, query) {
  const filter = { tenantId: actor.tenantId };

  // Scope applies to units currently in a warehouse. Dispatched units have no
  // warehouse — they belong to a customer — so they stay visible to anyone who
  // can view serials, which is what a support call needs.
  if (!actor.hasGlobalWarehouseScope) {
    filter.$or = [
      warehouseScopeFilter(actor),
      { warehouse: null },
    ];
  }

  if (query.status) filter.status = query.status;
  if (query.product) filter.product = query.product;
  if (query.warehouse) filter.warehouse = query.warehouse;
  if (query.customer) filter.customer = query.customer;
  if (query.search) {
    const rx = { $regex: escapeRegex(String(query.search).toUpperCase()), $options: 'i' };
    filter.$and = [{ $or: [{ serialNumber: rx }, { assetTag: rx }, { macAddress: rx }, { imei: rx }] }];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    SerialNumber.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .populate('customer', 'customerName customerCode'),
    SerialNumber.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

/**
 * The scan endpoint — one round trip, everything a person holding the unit
 * needs.
 *
 * This is the most-used call in the system once it is live: at the dock, at the
 * pick face, at a customer site. Making it one request rather than four is the
 * difference between a scanner feeling instant and feeling broken.
 *
 * Looked up by the serial number itself, not by an internal id, because that is
 * what is printed on the label.
 */
export async function findBySerialNumber(actor, serialNumber) {
  const serial = await SerialNumber.findOne({
    tenantId: actor.tenantId,
    serialNumber: String(serialNumber).trim().toUpperCase(),
  })
    .populate('product', 'name sku productType warrantyMonths')
    .populate('warehouse', 'name code')
    .populate('customer', 'customerName customerCode')
    .populate('vendor', 'vendorName vendorCode')
    .populate('grn', 'grnNumber receivedDate');

  if (!serial) throw new NotFoundError(`No unit found with serial number ${serialNumber}`, 'SERIAL_NOT_FOUND');

  const [recentEvents, ledgerCount] = await Promise.all([
    SerialNumberEvent.find({ tenantId: actor.tenantId, serialNumber: serial._id })
      .sort({ createdAt: -1 }).limit(5).populate('performedBy', 'fullName'),
    InventoryTransaction.countDocuments({ tenantId: actor.tenantId, serialNumber: serial._id }),
  ]);

  return {
    serial,
    recentEvents,
    ledgerCount,
    // What this unit may legally do next — lets the UI offer only valid actions
    // instead of showing buttons that will be refused.
    allowedTransitions: SERIAL_TRANSITIONS[serial.status] ?? [],
    countsAsStock: STATUS_BUCKET[serial.status] !== null,
  };
}

export async function getHistory(actor, id, { page = 1, limit = 50 } = {}) {
  const serial = await SerialNumber.findOne({ _id: id, tenantId: actor.tenantId });
  if (!serial) throw new NotFoundError('Serial number not found');

  const [events, total, movements] = await Promise.all([
    SerialNumberEvent.find({ tenantId: actor.tenantId, serialNumber: serial._id })
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('performedBy', 'fullName')
      .populate('warehouse', 'name code')
      .populate('customer', 'customerName'),
    SerialNumberEvent.countDocuments({ tenantId: actor.tenantId, serialNumber: serial._id }),
    InventoryTransaction.find({ tenantId: actor.tenantId, serialNumber: serial._id })
      .sort({ createdAt: -1 }).limit(limit)
      .populate('warehouse', 'name code'),
  ]);

  return { serial, events, movements, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

/**
 * Cross-checks serial counts against quantity buckets for a product.
 *
 * Serialized stock has two representations that must agree: the number in
 * `Inventory` and the number of serial records in the matching status. They are
 * written together inside one transaction, so they should never diverge — this
 * exists to prove it, and to catch it if they ever do.
 */
export async function auditSerialConsistency(tenantId, product) {
  const [byStatus, inventory] = await Promise.all([
    SerialNumber.aggregate([
      { $match: { tenantId, product } },
      { $group: { _id: { warehouse: '$warehouse', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Inventory.find({ tenantId, product }),
  ]);

  const serialTotals = new Map();
  for (const row of byStatus) {
    const bucket = STATUS_BUCKET[row._id.status];
    if (!bucket || !row._id.warehouse) continue;
    const key = `${row._id.warehouse}:${bucket}`;
    serialTotals.set(key, (serialTotals.get(key) ?? 0) + row.count);
  }

  const mismatches = [];
  const FIELD = {
    AVAILABLE: 'availableQuantity', RESERVED: 'reservedQuantity',
    DAMAGED: 'damagedQuantity', IN_TRANSIT: 'inTransitQuantity',
    UNDER_SERVICE: 'underServiceQuantity',
  };

  for (const row of inventory) {
    for (const [bucket, field] of Object.entries(FIELD)) {
      const quantity = row[field];
      const serials = serialTotals.get(`${row.warehouse}:${bucket}`) ?? 0;
      if (quantity !== serials) {
        mismatches.push({
          warehouse: String(row.warehouse), bucket, quantity, serials, difference: quantity - serials,
        });
      }
    }
  }

  return { checked: inventory.length, mismatches };
}

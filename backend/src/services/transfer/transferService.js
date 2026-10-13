import { WarehouseTransfer } from '../../models/WarehouseTransfer.js';
import { Warehouse } from '../../models/Warehouse.js';
import { Product } from '../../models/Product.js';
import { Inventory } from '../../models/Inventory.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';

/**
 * Warehouse transfers.
 *
 * The problem this solves: stock on a truck is in neither warehouse. If a
 * transfer simply decremented the source and incremented the destination, the
 * goods would either vanish for the length of the journey (decrement on
 * dispatch, increment on receipt) or exist in two places at once (both on
 * dispatch). Both are wrong, and both break any report that sums stock.
 *
 * So the goods move through a real, system-managed TRANSIT warehouse:
 *
 *   dispatch:  source AVAILABLE  −q   →   TRANSIT IN_TRANSIT  +q
 *   receipt:   TRANSIT IN_TRANSIT −q  →   destination AVAILABLE +q (or DAMAGED)
 *
 * Four ledger rows per line. At every instant — before dispatch, mid-journey,
 * after partial receipt — the sum of stock across all warehouses is unchanged.
 * That conservation property is what the integration tests assert.
 */

async function getTransitWarehouse(tenantId, session) {
  const transit = await Warehouse.findOne({
    tenantId, type: 'TRANSIT', isSystem: true, deletedAt: null,
  }).session(session ?? null);

  if (!transit) {
    throw new DomainError(
      'The system TRANSIT warehouse is missing. Run the seed script to create it.',
      'TRANSIT_WAREHOUSE_MISSING',
    );
  }
  return transit;
}

/** A transfer is visible to anyone scoped to either end of it. */
function assertTransferVisible(actor, transfer) {
  if (actor.hasGlobalWarehouseScope) return;
  const ends = [String(transfer.sourceWarehouse?._id ?? transfer.sourceWarehouse),
    String(transfer.destinationWarehouse?._id ?? transfer.destinationWarehouse)];
  if (!ends.some((w) => actor.warehouseIds.includes(w))) {
    throw new NotFoundError('Transfer not found', 'WAREHOUSE_OUT_OF_SCOPE');
  }
}

/** Specific ends need specific scope: you dispatch from your site and receive at yours. */
function assertAtEnd(actor, warehouseId, action) {
  if (actor.hasGlobalWarehouseScope) return;
  if (!actor.warehouseIds.includes(String(warehouseId))) {
    throw new NotFoundError(`You are not assigned to the warehouse that must ${action} this transfer`, 'WAREHOUSE_OUT_OF_SCOPE');
  }
}

export async function listTransfers(actor, query) {
  const filter = { tenantId: actor.tenantId, deletedAt: null };
  if (!actor.hasGlobalWarehouseScope) {
    filter.$or = [
      { sourceWarehouse: { $in: actor.warehouseIds } },
      { destinationWarehouse: { $in: actor.warehouseIds } },
    ];
  }
  if (query.status) filter.status = query.status;
  if (query.search) filter.transferNumber = { $regex: String(query.search).toUpperCase(), $options: 'i' };

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    WarehouseTransfer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('sourceWarehouse destinationWarehouse', 'name code')
      .populate('lines.product', 'name sku productType'),
    WarehouseTransfer.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getTransfer(actor, id) {
  const transfer = await WarehouseTransfer.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('sourceWarehouse destinationWarehouse', 'name code')
    .populate('lines.product', 'name sku productType unitOfMeasure')
    .populate('requestedBy approvedBy dispatchedBy receivedBy', 'fullName');
  if (!transfer) throw new NotFoundError('Transfer not found');
  assertTransferVisible(actor, transfer);
  return transfer;
}

export async function createTransfer(actor, payload) {
  if (String(payload.sourceWarehouse) === String(payload.destinationWarehouse)) {
    throw new DomainError('The source and destination must be different warehouses', 'SAME_WAREHOUSE');
  }

  // Either end in scope: a branch requesting stock and a main warehouse
  // offering it are both legitimate origins for a transfer.
  if (!actor.hasGlobalWarehouseScope) {
    const ends = [String(payload.sourceWarehouse), String(payload.destinationWarehouse)];
    if (!ends.some((w) => actor.warehouseIds.includes(w))) {
      throw new NotFoundError('Warehouse not found', 'WAREHOUSE_OUT_OF_SCOPE');
    }
  }

  const warehouses = await Warehouse.find({
    _id: { $in: [payload.sourceWarehouse, payload.destinationWarehouse] },
    tenantId: actor.tenantId, deletedAt: null,
  });
  if (warehouses.length !== 2) throw new NotFoundError('Warehouse not found');
  if (warehouses.some((w) => w.isSystem)) {
    throw new DomainError('Transfers cannot start or end at a system warehouse', 'SYSTEM_WAREHOUSE');
  }
  if (warehouses.some((w) => w.status !== 'ACTIVE')) {
    throw new DomainError('Both warehouses must be active', 'WAREHOUSE_INACTIVE');
  }

  const productIds = payload.lines.map((l) => String(l.product));
  if (new Set(productIds).size !== productIds.length) {
    throw new DomainError('Each product may appear only once on a transfer', 'DUPLICATE_TRANSFER_LINE');
  }

  const products = await Product.find({ _id: { $in: productIds }, tenantId: actor.tenantId, deletedAt: null });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const lines = [];
  for (const line of payload.lines) {
    const product = byId.get(String(line.product));
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);

    const serials = (line.serialNumbers ?? []).map((s) => String(s).trim().toUpperCase());

    if (product.productType === 'SERIALIZED') {
      if (serials.length !== line.requestedQuantity) {
        throw new DomainError(
          `${product.name}: ${line.requestedQuantity} requested but ${serials.length} serial numbers selected`,
          'SERIAL_COUNT_MISMATCH',
        );
      }
      // Checked here for a useful early error; re-checked atomically at dispatch,
      // which is the check that actually matters.
      const found = await SerialNumber.find({
        tenantId: actor.tenantId, product: product._id,
        serialNumber: { $in: serials }, warehouse: payload.sourceWarehouse, status: 'AVAILABLE',
      }).select('serialNumber');
      const available = new Set(found.map((s) => s.serialNumber));
      const missing = serials.filter((s) => !available.has(s));
      if (missing.length) {
        throw new DomainError(
          `Not available at the source warehouse: ${missing.join(', ')}`,
          'SERIAL_NOT_AVAILABLE',
          missing.map((s) => ({ code: 'SERIAL_NOT_AVAILABLE', serialNumber: s })),
        );
      }
    } else if (serials.length) {
      throw new DomainError(`${product.name} is not serialized`, 'SERIALS_NOT_APPLICABLE');
    }

    lines.push({ product: product._id, requestedQuantity: line.requestedQuantity, serialNumbers: serials, remarks: line.remarks });
  }

  const transferNumber = await nextDocumentNumber('TR');

  const transfer = await WarehouseTransfer.create({
    tenantId: actor.tenantId,
    transferNumber,
    sourceWarehouse: payload.sourceWarehouse,
    destinationWarehouse: payload.destinationWarehouse,
    lines,
    requestedBy: actor.id,
    remarks: payload.remarks ?? null,
    vehicleNumber: payload.vehicleNumber ?? null,
  });

  await writeAudit({
    action: 'TRANSFER_REQUESTED', module: 'WarehouseTransfer', recordId: transfer._id,
    recordLabel: transfer.transferNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  await notify({
    tenantId: actor.tenantId,
    type: 'TRANSFER_PENDING_APPROVAL',
    title: `Transfer ${transfer.transferNumber} awaits approval`,
    severity: 'NOTICE',
    recipientPermission: 'APPROVE_TRANSFER',
    module: 'WarehouseTransfer',
    recordId: transfer._id,
    actionUrl: '/transfers',
    dedupeKey: `TRANSFER_PENDING:${transfer._id}`,
  });

  return getTransfer(actor, transfer._id);
}

export async function approveTransfer(actor, id) {
  const transfer = await WarehouseTransfer.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!transfer) throw new NotFoundError('Transfer not found');
  assertTransferVisible(actor, transfer);

  if (transfer.status !== 'PENDING_APPROVAL') {
    throw new DomainError('Only a pending transfer can be approved', 'TRANSFER_NOT_PENDING');
  }
  // Same rule as purchase orders: an approval by the requester is not one.
  if (String(transfer.requestedBy) === String(actor.id) && !actor.can('MANAGE_SUPER_ADMIN')) {
    throw new DomainError('A transfer must be approved by someone other than its requester', 'SELF_APPROVAL_BLOCKED');
  }

  transfer.status = 'APPROVED';
  transfer.approvedBy = actor.id;
  transfer.approvedAt = new Date();
  await transfer.save();

  await writeAudit({
    action: 'TRANSFER_APPROVED', module: 'WarehouseTransfer', recordId: transfer._id,
    recordLabel: transfer.transferNumber, severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getTransfer(actor, transfer._id);
}

/**
 * Dispatch — goods leave the source and enter TRANSIT, in one transaction.
 *
 * For serialized lines, each serial goes AVAILABLE → IN_TRANSIT through the
 * state machine. If another request dispatched or reserved the same unit in
 * the meantime, MongoDB detects the write conflict on that serial document,
 * aborts one transaction, and on retry the transition table rejects it —
 * because IN_TRANSIT → IN_TRANSIT is not a legal move. The same unit cannot
 * leave on two trucks.
 */
export async function dispatchTransfer(actor, id, { vehicleNumber } = {}) {
  const transferId = await withTransaction(async ({ session, onCommit }) => {
    const transfer = await WarehouseTransfer.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!transfer) throw new NotFoundError('Transfer not found');
    assertAtEnd(actor, transfer.sourceWarehouse, 'dispatch');

    if (transfer.status !== 'APPROVED') {
      throw new ConflictError(
        transfer.status === 'IN_TRANSIT' ? 'This transfer has already been dispatched' : 'Only an approved transfer can be dispatched',
        'TRANSFER_NOT_DISPATCHABLE',
      );
    }

    const transit = await getTransitWarehouse(actor.tenantId, session);

    for (const line of transfer.lines) {
      const qty = line.requestedQuantity;
      const ref = {
        transactionType: 'WAREHOUSE_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: transfer._id,
        referenceNumber: transfer.transferNumber,
      };

      // Guarded: fails with INSUFFICIENT_STOCK if the source no longer holds it.
      await applyMovement({
        session, actor, product: line.product, warehouse: transfer.sourceWarehouse,
        bucket: 'AVAILABLE', quantityChange: -qty, ...ref, remarks: 'Dispatched to transit',
      });
      await applyMovement({
        session, actor, product: line.product, warehouse: transit._id,
        bucket: 'IN_TRANSIT', quantityChange: qty, ...ref, remarks: 'In transit',
      });

      if (line.serialNumbers.length) {
        const serials = await SerialNumber.find({
          tenantId: actor.tenantId, serialNumber: { $in: line.serialNumbers },
        }).session(session);

        if (serials.length !== line.serialNumbers.length) {
          throw new DomainError('One or more selected serial numbers no longer exist', 'SERIAL_NOT_FOUND');
        }

        for (const serial of serials) {
          if (String(serial.warehouse) !== String(transfer.sourceWarehouse)) {
            throw new DomainError(
              `${serial.serialNumber} is no longer at the source warehouse`,
              'SERIAL_NOT_AT_SOURCE',
            );
          }
          await serialService.transition({
            session, actor, serial, toStatus: 'IN_TRANSIT', eventType: 'TRANSFER_DISPATCHED',
            referenceType: 'TRANSFER', referenceId: transfer._id,
            referenceNumber: transfer.transferNumber, warehouse: transit._id,
          });
        }
      }

      line.dispatchedQuantity = qty;
    }

    transfer.status = 'IN_TRANSIT';
    transfer.dispatchedBy = actor.id;
    transfer.dispatchedAt = new Date();
    if (vehicleNumber) transfer.vehicleNumber = vehicleNumber;
    await transfer.save({ session });

    onCommit(() => writeAudit({
      action: 'TRANSFER_DISPATCHED', module: 'WarehouseTransfer', recordId: transfer._id,
      recordLabel: transfer.transferNumber, severity: 'WARNING', tenantId: actor.tenantId,
    }));

    return transfer._id;
  });

  return getTransfer(actor, transferId);
}

/**
 * Receipt — goods leave TRANSIT and enter the destination. May be partial,
 * and may be called more than once as a shipment arrives in pieces.
 *
 * Units neither received nor recorded damaged stay IN_TRANSIT, visibly. Short
 * receipts are not silently absorbed: missing goods remain on the books as "in
 * transit" until someone investigates, which is the correct amount of noise
 * for goods that have gone missing between two of your own buildings.
 */
export async function receiveTransfer(actor, id, { lines: receipts, remarks } = {}) {
  const transferId = await withTransaction(async ({ session, onCommit }) => {
    const transfer = await WarehouseTransfer.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!transfer) throw new NotFoundError('Transfer not found');
    assertAtEnd(actor, transfer.destinationWarehouse, 'receive');

    if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(transfer.status)) {
      throw new ConflictError('There is nothing in transit to receive on this transfer', 'TRANSFER_NOT_RECEIVABLE');
    }

    const transit = await getTransitWarehouse(actor.tenantId, session);
    const products = await Product.find({ _id: { $in: transfer.lines.map((l) => l.product) } }).session(session);
    const productById = new Map(products.map((p) => [String(p._id), p]));

    for (const receipt of receipts) {
      const line = transfer.lines.id(receipt.lineId);
      if (!line) throw new NotFoundError(`Transfer line ${receipt.lineId} not found`);

      const product = productById.get(String(line.product));
      const outstanding = transfer.outstandingFor(line);

      let received;
      let damaged;
      let receivedSerials = [];
      let damagedSerials = [];

      if (product.productType === 'SERIALIZED') {
        // For serialized goods the quantities ARE the serial lists — counts
        // typed separately could disagree with the units actually scanned.
        receivedSerials = (receipt.receivedSerials ?? []).map((s) => s.toUpperCase());
        damagedSerials = (receipt.damagedSerials ?? []).map((s) => s.toUpperCase());

        const pending = new Set(line.serialNumbers.filter(
          (s) => !line.receivedSerials.includes(s) && !line.damagedSerials.includes(s),
        ));
        const offered = [...receivedSerials, ...damagedSerials];
        const foreign = offered.filter((s) => !pending.has(s));
        if (foreign.length) {
          throw new DomainError(
            `Not outstanding on this transfer: ${foreign.join(', ')}`,
            'SERIAL_NOT_ON_TRANSFER',
          );
        }
        if (new Set(offered).size !== offered.length) {
          throw new DomainError('A serial number is listed more than once', 'DUPLICATE_SERIAL');
        }
        received = receivedSerials.length;
        damaged = damagedSerials.length;
      } else {
        received = receipt.receivedQuantity ?? 0;
        damaged = receipt.damagedQuantity ?? 0;
      }

      if (received + damaged === 0) continue;
      if (received + damaged > outstanding) {
        throw new DomainError(
          `${product.name}: ${outstanding} outstanding in transit, but ${received + damaged} recorded`,
          'OVER_RECEIPT_EXCEEDED',
        );
      }

      const ref = {
        transactionType: 'WAREHOUSE_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: transfer._id,
        referenceNumber: transfer.transferNumber,
      };

      await applyMovement({
        session, actor, product: line.product, warehouse: transit._id,
        bucket: 'IN_TRANSIT', quantityChange: -(received + damaged), ...ref, remarks: 'Arrived at destination',
      });
      if (received > 0) {
        await applyMovement({
          session, actor, product: line.product, warehouse: transfer.destinationWarehouse,
          bucket: 'AVAILABLE', quantityChange: received, ...ref,
        });
      }
      if (damaged > 0) {
        await applyMovement({
          session, actor, product: line.product, warehouse: transfer.destinationWarehouse,
          bucket: 'DAMAGED', quantityChange: damaged, ...ref, remarks: 'Damaged in transit',
        });
      }

      for (const [list, toStatus, eventType] of [
        [receivedSerials, 'AVAILABLE', 'TRANSFER_RECEIVED'],
        [damagedSerials, 'DAMAGED', 'TRANSFER_RECEIVED_DAMAGED'],
      ]) {
        if (!list.length) continue;
        const serials = await SerialNumber.find({
          tenantId: actor.tenantId, serialNumber: { $in: list },
        }).session(session);
        for (const serial of serials) {
          await serialService.transition({
            session, actor, serial, toStatus, eventType,
            referenceType: 'TRANSFER', referenceId: transfer._id,
            referenceNumber: transfer.transferNumber, warehouse: transfer.destinationWarehouse,
            extra: toStatus === 'DAMAGED' ? { condition: 'DAMAGED' } : {},
          });
        }
      }

      line.receivedQuantity += received;
      line.damagedInTransitQuantity += damaged;
      line.receivedSerials.push(...receivedSerials);
      line.damagedSerials.push(...damagedSerials);
    }

    const stillOutstanding = transfer.lines.reduce((s, l) => s + transfer.outstandingFor(l), 0);
    transfer.status = stillOutstanding === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    transfer.receivedBy = actor.id;
    transfer.receivedAt = new Date();
    if (remarks) transfer.remarks = remarks;
    await transfer.save({ session });

    onCommit(() => writeAudit({
      action: stillOutstanding === 0 ? 'TRANSFER_RECEIVED' : 'TRANSFER_PARTIALLY_RECEIVED',
      module: 'WarehouseTransfer', recordId: transfer._id, recordLabel: transfer.transferNumber,
      severity: stillOutstanding === 0 ? 'NOTICE' : 'WARNING',
      tenantId: actor.tenantId,
      metadata: { stillInTransit: stillOutstanding },
    }));

    return transfer._id;
  });

  return getTransfer(actor, transferId);
}

/** Cancellation is only possible before anything has physically moved. */
export async function cancelTransfer(actor, id, reason) {
  const transfer = await WarehouseTransfer.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null });
  if (!transfer) throw new NotFoundError('Transfer not found');
  assertTransferVisible(actor, transfer);

  if (!['PENDING_APPROVAL', 'APPROVED'].includes(transfer.status)) {
    throw new DomainError(
      'Goods are already on the move. Receive them at the destination rather than cancelling.',
      'TRANSFER_ALREADY_DISPATCHED',
    );
  }

  transfer.status = 'CANCELLED';
  transfer.cancelledBy = actor.id;
  transfer.cancelReason = reason;
  await transfer.save();

  await writeAudit({
    action: 'TRANSFER_CANCELLED', module: 'WarehouseTransfer', recordId: transfer._id,
    recordLabel: transfer.transferNumber, severity: 'WARNING', tenantId: actor.tenantId,
    metadata: { reason },
  });

  return getTransfer(actor, transfer._id);
}

/** Total units across every bucket in every warehouse — used by the conservation tests. */
export async function totalSystemStock(tenantId, product) {
  const rows = await Inventory.find({ tenantId, product });
  return rows.reduce((sum, r) => sum + r.availableQuantity + r.reservedQuantity
    + r.damagedQuantity + r.inTransitQuantity + r.underServiceQuantity, 0);
}

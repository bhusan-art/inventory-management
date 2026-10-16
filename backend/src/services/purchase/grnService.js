import mongoose from 'mongoose';
import { GRN } from '../../models/GRN.js';
import { PurchaseOrder } from '../../models/PurchaseOrder.js';
import { Product } from '../../models/Product.js';
import { Vendor } from '../../models/Vendor.js';
import { Warehouse } from '../../models/Warehouse.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { InventoryTransaction } from '../../models/InventoryTransaction.js';
import { withTransaction } from '../shared/transaction.js';
import { nextDocumentNumber } from '../shared/counterService.js';
import { writeAudit } from '../shared/auditService.js';
import { notify } from '../shared/notificationService.js';
import { applyMovement } from '../inventory/ledgerService.js';
import * as serialService from '../serial/serialService.js';
import { assertWarehouseInScope } from '../shared/scopeService.js';
import { NotFoundError, DomainError, ConflictError } from '../../utils/errors.js';
import { parseSort } from '../../validators/common.schema.js';

const OVER_RECEIPT_TOLERANCE_PERCENT = 0;

export async function listGrns(actor, query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.vendor) filter.vendor = query.vendor;
  if (query.search) filter.grnNumber = { $regex: String(query.search).toUpperCase(), $options: 'i' };

  // Warehouse-scoped users see only their own sites. Applied as a mandatory
  // condition, not a filter the caller can override.
  if (!actor.hasGlobalWarehouseScope) filter.warehouse = { $in: actor.warehouseIds };

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Number(query.limit) || 25);

  const [items, total] = await Promise.all([
    GRN.find({ ...filter, tenantId: actor.tenantId, deletedAt: null })
      .sort(parseSort(query.sort, { receivedDate: -1 }))
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('vendor', 'vendorName vendorCode')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku productType'),
    GRN.countDocuments({ ...filter, tenantId: actor.tenantId, deletedAt: null }),
  ]);

  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 } };
}

export async function getGrn(actor, id) {
  const grn = await GRN.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null })
    .populate('vendor', 'vendorName vendorCode')
    .populate('warehouse', 'name code')
    .populate('purchaseOrder', 'poNumber status')
    .populate('lines.product', 'name sku productType serialFormatPattern')
    .populate('receivedBy postedBy', 'fullName');

  if (!grn) throw new NotFoundError('GRN not found');
  assertWarehouseInScope(actor, grn.warehouse?._id ?? grn.warehouse);
  return grn;
}

/**
 * Creates a GRN in DRAFT. Nothing moves yet.
 *
 * Draft and posted are separated deliberately: receiving is often entered at
 * the dock over several minutes, and half-entered stock must not be visible as
 * available. Posting is the single irreversible moment.
 */
export async function createGrn(actor, payload) {
  await assertWarehouseInScope(actor, payload.warehouse);

  const [vendor, warehouse] = await Promise.all([
    Vendor.findOne({ _id: payload.vendor, tenantId: actor.tenantId, deletedAt: null }),
    Warehouse.findOne({ _id: payload.warehouse, tenantId: actor.tenantId, deletedAt: null }),
  ]);

  if (!vendor) throw new NotFoundError('Vendor not found');
  if (vendor.status === 'BLACKLISTED') {
    throw new DomainError('This vendor is blacklisted and cannot be received from', 'VENDOR_BLACKLISTED');
  }
  if (!warehouse) throw new NotFoundError('Warehouse not found');
  if (warehouse.isSystem) {
    throw new DomainError('Goods cannot be received directly into a system warehouse', 'SYSTEM_WAREHOUSE');
  }

  let purchaseOrder = null;
  if (payload.purchaseOrder) {
    purchaseOrder = await PurchaseOrder.findOne({
      _id: payload.purchaseOrder, tenantId: actor.tenantId, deletedAt: null,
    });
    if (!purchaseOrder) throw new NotFoundError('Purchase order not found');
    if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(purchaseOrder.status)) {
      throw new DomainError(
        `Goods cannot be received against a ${purchaseOrder.status.toLowerCase().replace('_', ' ')} purchase order`,
        'PO_NOT_RECEIVABLE',
      );
    }
    if (String(purchaseOrder.vendor) !== String(payload.vendor)) {
      throw new DomainError('This purchase order belongs to a different vendor', 'PO_VENDOR_MISMATCH');
    }
  }

  const lines = await prepareLines(actor, payload.lines, purchaseOrder);

  if (payload.vendorInvoiceNumber) {
    const duplicate = await GRN.findOne({
      tenantId: actor.tenantId,
      vendor: payload.vendor,
      vendorInvoiceNumber: payload.vendorInvoiceNumber,
      status: { $ne: 'CANCELLED' },
      deletedAt: null,
    });
    if (duplicate) {
      throw new ConflictError(
        `Invoice ${payload.vendorInvoiceNumber} has already been received from this vendor on ${duplicate.grnNumber}`,
        'DUPLICATE_VENDOR_INVOICE',
      );
    }
  }

  const grnNumber = await nextDocumentNumber('GRN');

  const grn = await GRN.create({
    tenantId: actor.tenantId,
    grnNumber,
    vendor: payload.vendor,
    purchaseOrder: payload.purchaseOrder ?? null,
    warehouse: payload.warehouse,
    vendorInvoiceNumber: payload.vendorInvoiceNumber ?? null,
    vendorInvoiceDate: payload.vendorInvoiceDate ?? null,
    vendorChallanNumber: payload.vendorChallanNumber ?? null,
    receivedDate: payload.receivedDate ?? new Date(),
    receivedBy: actor.id,
    vehicleNumber: payload.vehicleNumber ?? null,
    lines,
    remarks: payload.remarks ?? null,
    status: 'DRAFT',
    createdBy: actor.id,
  });

  await writeAudit({
    action: 'GRN_CREATED', module: 'GRN', recordId: grn._id, recordLabel: grn.grnNumber,
    severity: 'NOTICE', tenantId: actor.tenantId,
  });

  return getGrn(actor, grn._id);
}

/** Validates each line against its product and, when present, its PO line. */
async function prepareLines(actor, lines, purchaseOrder) {
  const productIds = lines.map((l) => l.product);
  const products = await Product.find({
    _id: { $in: productIds }, tenantId: actor.tenantId, deletedAt: null,
  });
  const byId = new Map(products.map((p) => [String(p._id), p]));

  return lines.map((line) => {
    const product = byId.get(String(line.product));
    if (!product) throw new NotFoundError(`Product ${line.product} not found`);
    if (product.status !== 'ACTIVE') {
      throw new DomainError(`${product.name} is not active and cannot be received`, 'PRODUCT_INACTIVE');
    }

    const accepted = line.acceptedQuantity;
    const serials = (line.serialNumbers ?? []).map((s) => String(s).trim().toUpperCase());

    if (product.productType === 'SERIALIZED') {
      // One serial per accepted unit — the count is the check that nothing was
      // scanned twice or missed.
      if (serials.length !== accepted) {
        throw new DomainError(
          `${product.name}: ${accepted} accepted but ${serials.length} serial numbers supplied`,
          'SERIAL_COUNT_MISMATCH',
          [{ code: 'SERIAL_COUNT_MISMATCH', product: product.name, accepted, supplied: serials.length }],
        );
      }
      serialService.assertMatchesFormat(product, serials);
    } else if (serials.length > 0) {
      throw new DomainError(
        `${product.name} is not a serialized product, so serial numbers cannot be recorded against it`,
        'SERIALS_NOT_APPLICABLE',
      );
    }

    let orderedQuantity = 0;
    let poLineId = null;

    if (purchaseOrder) {
      const poLine = purchaseOrder.lines.find((l) => String(l.product) === String(line.product));
      if (!poLine) {
        throw new DomainError(
          `${product.name} is not on purchase order ${purchaseOrder.poNumber}`,
          'PRODUCT_NOT_ON_PO',
        );
      }

      const alreadySettled = poLine.receivedQuantity + poLine.rejectedQuantity + poLine.shortClosedQuantity;
      const outstanding = poLine.orderedQuantity - alreadySettled;
      const tolerance = Math.floor(poLine.orderedQuantity * (OVER_RECEIPT_TOLERANCE_PERCENT / 100));

      if (line.receivedQuantity > outstanding + tolerance) {
        throw new DomainError(
          `${product.name}: ${outstanding} still outstanding on ${purchaseOrder.poNumber}, `
          + `but ${line.receivedQuantity} received`,
          'OVER_RECEIPT_EXCEEDED',
          [{ code: 'OVER_RECEIPT_EXCEEDED', product: product.name, outstanding, received: line.receivedQuantity }],
        );
      }

      orderedQuantity = poLine.orderedQuantity;
      poLineId = poLine._id;
    }

    return {
      product: line.product,
      poLineId,
      orderedQuantity,
      receivedQuantity: line.receivedQuantity,
      acceptedQuantity: accepted,
      damagedQuantity: line.damagedQuantity ?? 0,
      rejectedQuantity: line.rejectedQuantity ?? 0,
      shortQuantity: line.shortQuantity ?? 0,
      rackLocation: line.rackLocation ?? null,
      batchNumber: line.batchNumber ?? null,
      manufacturingDate: line.manufacturingDate ?? null,
      expiryDate: line.expiryDate ?? null,
      serialNumbers: (line.serialNumbers ?? []).map((s) => String(s).trim().toUpperCase()),
      remarks: line.remarks ?? null,
    };
  });
}

/**
 * POSTING — the irreversible moment, and one transaction.
 *
 * Steps, all inside it:
 *   1. re-read and re-validate the GRN (it may have been posted since load)
 *   2. per line: accepted → AVAILABLE, damaged → DAMAGED, each with a ledger row
 *   3. create serial records and their history events
 *   4. update PO line tallies and derive the PO status
 *   5. mark the GRN POSTED
 *
 * If step 3 throws — a duplicate serial on the last unit of a 200-unit pallet —
 * steps 2 and 4 must not survive. That is the property the Phase 0 rollback
 * test proved, and this is the first place it matters.
 */
export async function postGrn(actor, id) {
  const result = await withTransaction(async ({ session, onCommit }) => {
    const grn = await GRN.findOne({
      _id: id, tenantId: actor.tenantId, deletedAt: null,
    }).session(session);

    if (!grn) throw new NotFoundError('GRN not found');
    await assertWarehouseInScope(actor, grn.warehouse);

    // Idempotency: a retried request must not double the stock.
    if (grn.status === 'POSTED') {
      throw new ConflictError(`${grn.grnNumber} has already been posted`, 'GRN_ALREADY_POSTED');
    }
    if (grn.status === 'CANCELLED') {
      throw new DomainError('A cancelled GRN cannot be posted', 'GRN_CANCELLED');
    }

    const products = await Product.find({
      _id: { $in: grn.lines.map((l) => l.product) }, tenantId: actor.tenantId,
    }).session(session);
    const byId = new Map(products.map((p) => [String(p._id), p]));

    let serialsCreated = 0;

    for (const line of grn.lines) {
      const product = byId.get(String(line.product));

      if (line.acceptedQuantity > 0) {
        await applyMovement({
          session,
          actor,
          product: line.product,
          warehouse: grn.warehouse,
          bucket: 'AVAILABLE',
          quantityChange: line.acceptedQuantity,
          transactionType: 'PURCHASE_RECEIVED',
          referenceType: 'GRN',
          referenceId: grn._id,
          referenceNumber: grn.grnNumber,
          rackLocation: line.rackLocation,
        });
      }

      // Damaged units are visible and countable but not saleable. They leave
      // through a vendor return or a scrap adjustment, each with its own row.
      if (line.damagedQuantity > 0) {
        await applyMovement({
          session,
          actor,
          product: line.product,
          warehouse: grn.warehouse,
          bucket: 'DAMAGED',
          quantityChange: line.damagedQuantity,
          transactionType: 'PURCHASE_RECEIVED',
          referenceType: 'GRN',
          referenceId: grn._id,
          referenceNumber: grn.grnNumber,
          remarks: 'Received damaged',
        });
      }

      // Rejected and short quantities increase nothing. They are a claim
      // against the vendor, recorded on the GRN and surfaced on the PO.

      if (product.productType === 'SERIALIZED' && line.serialNumbers.length > 0) {
        const created = await serialService.createForReceipt({
          session,
          actor,
          product: line.product,
          warehouse: grn.warehouse,
          grn: grn._id,
          vendor: grn.vendor,
          serialNumbers: line.serialNumbers,
          rackLocation: line.rackLocation,
          batchNumber: line.batchNumber,
          manufacturingDate: line.manufacturingDate,
          receivedDate: grn.receivedDate,
        });

        // RECEIVED → AVAILABLE: QC passed at the dock, since these units were
        // booked as accepted rather than damaged.
        for (const serial of created) {
          await serialService.transition({
            session,
            actor,
            serial,
            toStatus: 'AVAILABLE',
            eventType: 'QC_PASSED',
            referenceType: 'GRN',
            referenceId: grn._id,
            referenceNumber: grn.grnNumber,
          });
        }
        serialsCreated += created.length;
      }
    }

    if (grn.purchaseOrder) {
      const po = await PurchaseOrder.findOne({
        _id: grn.purchaseOrder, tenantId: actor.tenantId,
      }).session(session);

      if (po) {
        for (const line of grn.lines) {
          const poLine = line.poLineId
            ? po.lines.id(line.poLineId)
            : po.lines.find((l) => String(l.product) === String(line.product));
          if (!poLine) continue;

          poLine.receivedQuantity += line.acceptedQuantity + line.damagedQuantity;
          poLine.rejectedQuantity += line.rejectedQuantity;
        }
        po.recalculateStatus();
        await po.save({ session });
      }
    }

    grn.status = 'POSTED';
    grn.postedAt = new Date();
    grn.postedBy = actor.id;
    await grn.save({ session });

    /**
     * Only when something was WRONG with the delivery.
     *
     * A clean receipt needs no alert — the stock figure already changed and
     * anyone interested can see it. Damage or rejection is different: somebody
     * has to raise it with the vendor, and nothing else in the system will
     * remind them. Notifying on every receipt is how a notification list
     * becomes wallpaper.
     */
    const damaged = grn.lines.reduce((sum, l) => sum + l.damagedQuantity, 0);
    const rejected = grn.lines.reduce((sum, l) => sum + l.rejectedQuantity, 0);

    if (damaged + rejected > 0) {
      onCommit(() => notify({
        tenantId: actor.tenantId,
        type: 'GRN_DAMAGE_RECORDED',
        title: `${grn.grnNumber} received with ${damaged} damaged, ${rejected} rejected`,
        body: 'Raise this with the vendor — nothing else will chase it.',
        severity: 'WARNING',
        recipientPermission: 'VIEW_GRN',
        module: 'GRN',
        recordId: grn._id,
        actionUrl: '/grn',
        dedupeKey: `GRN_DAMAGE:${grn._id}`,
      }));
    }

    // Runs only after the commit — an audit write that fails must never roll
    // back a stock movement that already happened.
    onCommit(() => writeAudit({
      action: 'GRN_POSTED', module: 'GRN', recordId: grn._id, recordLabel: grn.grnNumber,
      severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: {
        lines: grn.lines.length,
        accepted: grn.lines.reduce((s, l) => s + l.acceptedQuantity, 0),
        damaged: grn.lines.reduce((s, l) => s + l.damagedQuantity, 0),
        serialsCreated,
      },
    }));

    return grn._id;
  });

  return getGrn(actor, result);
}

/**
 * Cancels a posted GRN by writing compensating entries.
 *
 * Not an undo: the original ledger rows stay, and reversing rows are added
 * pointing back at them. Editing posted stock history is not offered anywhere
 * in this system, because a ledger that can be rewritten cannot be trusted as
 * evidence of anything.
 */
export async function cancelGrn(actor, id, reason) {
  const result = await withTransaction(async ({ session, onCommit }) => {
    const grn = await GRN.findOne({ _id: id, tenantId: actor.tenantId, deletedAt: null }).session(session);
    if (!grn) throw new NotFoundError('GRN not found');

    if (grn.status === 'CANCELLED') {
      throw new ConflictError('This GRN is already cancelled', 'GRN_ALREADY_CANCELLED');
    }

    if (grn.status === 'POSTED') {
      // Serials must still be in stock. Once a unit has been dispatched or
      // transferred, the receipt cannot be unwound without corrupting the
      // history of everything that happened to it since.
      const moved = await SerialNumber.countDocuments({
        tenantId: actor.tenantId,
        grn: grn._id,
        status: { $nin: ['AVAILABLE', 'RECEIVED', 'DAMAGED'] },
      }).session(session);

      if (moved > 0) {
        throw new DomainError(
          `${moved} unit${moved === 1 ? '' : 's'} from this GRN have already moved on. `
          + 'Use a vendor return instead of cancelling the receipt.',
          'GRN_UNITS_ALREADY_MOVED',
        );
      }

      const originals = await InventoryTransaction.find({
        tenantId: actor.tenantId, referenceType: 'GRN', referenceId: grn._id, reversalOf: null,
      }).session(session);

      for (const original of originals) {
        await applyMovement({
          session,
          actor,
          product: original.product,
          warehouse: original.warehouse,
          bucket: original.bucketTo ?? 'AVAILABLE',
          quantityChange: -original.quantityChange,
          transactionType: 'VENDOR_RETURN',
          referenceType: 'GRN',
          referenceId: grn._id,
          referenceNumber: grn.grnNumber,
          reasonCode: 'GRN_CANCELLED',
          remarks: reason,
        });
      }

      await SerialNumber.deleteMany({
        tenantId: actor.tenantId,
        grn: grn._id,
        status: { $in: ['AVAILABLE', 'RECEIVED', 'DAMAGED'] },
      }).session(session);

      if (grn.purchaseOrder) {
        const po = await PurchaseOrder.findOne({ _id: grn.purchaseOrder, tenantId: actor.tenantId }).session(session);
        if (po) {
          for (const line of grn.lines) {
            const poLine = line.poLineId ? po.lines.id(line.poLineId) : null;
            if (!poLine) continue;
            poLine.receivedQuantity = Math.max(0, poLine.receivedQuantity - line.acceptedQuantity - line.damagedQuantity);
            poLine.rejectedQuantity = Math.max(0, poLine.rejectedQuantity - line.rejectedQuantity);
          }
          po.recalculateStatus();
          await po.save({ session });
        }
      }
    }

    grn.status = 'CANCELLED';
    grn.cancelledAt = new Date();
    grn.cancelledBy = actor.id;
    grn.cancelReason = reason;
    await grn.save({ session });

    onCommit(() => writeAudit({
      action: 'GRN_CANCELLED', module: 'GRN', recordId: grn._id, recordLabel: grn.grnNumber,
      severity: 'CRITICAL', tenantId: actor.tenantId, metadata: { reason },
    }));

    return grn._id;
  });

  return getGrn(actor, result);
}

export { mongoose };

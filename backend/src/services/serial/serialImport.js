import { SerialNumber } from '../../models/SerialNumber.js';
import { Product } from '../../models/Product.js';
import { Warehouse } from '../../models/Warehouse.js';
import { withTransaction } from '../shared/transaction.js';
import { writeAudit } from '../shared/auditService.js';
import { applyMovement } from '../inventory/ledgerService.js';
import { parseCsv } from '../master/productImport.js';
import * as serialService from './serialService.js';
import { DomainError, NotFoundError } from '../../utils/errors.js';

const MAX_ROWS = 2000;

/**
 * Opening-balance import for serialized stock.
 *
 * This is the go-live problem: you already own 400 servers, and the system has
 * never seen them. Receiving them as a fictional GRN would invent a purchase
 * that never happened; creating serial records alone would leave the serial
 * count disagreeing with the quantity.
 *
 * So the import does both, honestly: each unit becomes a serial record AND a
 * `STOCK_ADJUSTMENT` ledger entry with reason `DATA_CORRECTION`. The stock
 * appears with a truthful explanation of where it came from — an opening
 * balance, not a receipt.
 *
 * Gated on ADJUST_INVENTORY_UNLIMITED, because it creates stock from nothing.
 * All-or-nothing, for the same reason as the product import: a partial load is
 * unrecoverable by hand.
 */
export async function importSerials(actor, { csv, warehouse: warehouseId, dryRun = true }) {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new DomainError('The file contains no data rows', 'EMPTY_IMPORT');
  if (rows.length > MAX_ROWS) {
    throw new DomainError(`Serial imports are limited to ${MAX_ROWS} rows per file`, 'IMPORT_TOO_LARGE');
  }

  const warehouse = await Warehouse.findOne({
    _id: warehouseId, tenantId: actor.tenantId, deletedAt: null,
  });
  if (!warehouse) throw new NotFoundError('Warehouse not found');
  if (warehouse.isSystem) throw new DomainError('Stock cannot be imported into a system warehouse', 'SYSTEM_WAREHOUSE');

  const products = await Product.find({
    tenantId: actor.tenantId, deletedAt: null, productType: 'SERIALIZED',
  }).select('sku name serialFormatPattern').lean();
  const bySku = new Map(products.map((p) => [p.sku.toUpperCase(), p]));

  const incoming = rows.map((r) => String(r.serialNumber ?? r.serial ?? '').trim().toUpperCase());
  const existing = new Set(
    (await SerialNumber.find({ tenantId: actor.tenantId, serialNumber: { $in: incoming } })
      .select('serialNumber').lean()).map((s) => s.serialNumber),
  );

  const errors = [];
  const prepared = [];
  const seen = new Set();

  rows.forEach((row, index) => {
    const line = index + 2;
    const issues = [];
    const serialNumber = String(row.serialNumber ?? row.serial ?? '').trim().toUpperCase();
    const sku = String(row.sku ?? '').trim().toUpperCase();

    if (!serialNumber) issues.push('serialNumber is required');
    if (existing.has(serialNumber)) issues.push(`${serialNumber} already exists in the system`);
    if (seen.has(serialNumber)) issues.push(`${serialNumber} is duplicated in this file`);
    seen.add(serialNumber);

    const product = bySku.get(sku);
    if (!sku) issues.push('sku is required');
    else if (!product) issues.push(`no serialized product with SKU "${sku}"`);

    if (product?.serialFormatPattern && serialNumber) {
      try {
        serialService.assertMatchesFormat(
          { name: product.name, serialFormatPattern: product.serialFormatPattern },
          [serialNumber],
        );
      } catch {
        issues.push(`${serialNumber} does not match the format for ${product.name}`);
      }
    }

    if (issues.length) errors.push({ line, serialNumber: serialNumber || null, issues });
    else {
      prepared.push({
        serialNumber,
        product: product._id,
        assetTag: row.assetTag ? String(row.assetTag).trim().toUpperCase() : null,
        macAddress: row.macAddress ? String(row.macAddress).trim().toUpperCase() : null,
        imei: row.imei ? String(row.imei).trim().toUpperCase() : null,
        rackLocation: row.rackLocation ? String(row.rackLocation).trim().toUpperCase() : null,
        condition: ['NEW', 'REFURBISHED', 'DAMAGED'].includes(String(row.condition ?? '').toUpperCase())
          ? String(row.condition).toUpperCase() : 'NEW',
      });
    }
  });

  const summary = {
    totalRows: rows.length,
    valid: prepared.length,
    invalid: errors.length,
    errors: errors.slice(0, 100),
    truncatedErrors: Math.max(0, errors.length - 100),
    dryRun,
    imported: 0,
  };

  if (errors.length > 0) {
    summary.message = 'Nothing was imported. Fix the rows listed and upload again.';
    return summary;
  }
  if (dryRun) {
    summary.message = `${prepared.length} units are valid and ready to import.`;
    return summary;
  }

  await withTransaction(async ({ session, onCommit }) => {
    // Group by product so each product gets one ledger entry rather than one
    // per unit — 400 rows should not produce 400 adjustment entries.
    const byProduct = new Map();
    for (const item of prepared) {
      const key = String(item.product);
      byProduct.set(key, (byProduct.get(key) ?? 0) + 1);
    }

    const created = await SerialNumber.create(
      prepared.map((item) => ({
        tenantId: actor.tenantId,
        serialNumber: item.serialNumber,
        product: item.product,
        warehouse: warehouse._id,
        assetTag: item.assetTag,
        macAddress: item.macAddress,
        imei: item.imei,
        rackLocation: item.rackLocation,
        condition: item.condition,
        status: 'RECEIVED',
        receivedDate: new Date(),
      })),
      { session, ordered: true },
    );

    for (const serial of created) {
      await serialService.transition({
        session, actor, serial, toStatus: 'AVAILABLE',
        eventType: 'OPENING_BALANCE_IMPORT',
        referenceType: 'ADJUSTMENT',
        remarks: 'Imported as opening balance',
      });
    }

    for (const [productId, quantity] of byProduct) {
      await applyMovement({
        session, actor, product: productId, warehouse: warehouse._id,
        bucket: 'AVAILABLE', quantityChange: quantity,
        transactionType: 'STOCK_ADJUSTMENT', referenceType: 'ADJUSTMENT',
        reasonCode: 'DATA_CORRECTION',
        remarks: `Opening balance import of ${quantity} serialized unit(s)`,
      });
    }

    onCommit(() => writeAudit({
      action: 'SERIAL_OPENING_BALANCE_IMPORT', module: 'SerialNumber',
      severity: 'CRITICAL', tenantId: actor.tenantId,
      metadata: { units: prepared.length, warehouse: warehouse.code, products: byProduct.size },
    }));
  });

  summary.imported = prepared.length;
  summary.message = `${prepared.length} units imported as opening balance at ${warehouse.code}.`;
  return summary;
}

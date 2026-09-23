import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Inventory } from '../../src/models/Inventory.js';
import { InventoryTransaction } from '../../src/models/InventoryTransaction.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { Notification } from '../../src/models/Notification.js';
import { StockCount } from '../../src/models/StockCount.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

/** Seeds stock directly through the ledger, as a receipt would. */
async function giveStock(product, warehouse, quantity, bucket = 'AVAILABLE') {
  const { withTransaction } = await import('../../src/services/shared/transaction.js');
  const { applyMovement } = await import('../../src/services/inventory/ledgerService.js');
  const actor = { id: ctx.adminId, tenantId: ctx.company._id };
  await withTransaction(({ session }) => applyMovement({
    session, actor, product, warehouse, bucket,
    quantityChange: quantity,
    transactionType: 'PURCHASE_RECEIVED', referenceType: 'GRN',
  }));
}

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'INVENTORY_MANAGER', 'WAREHOUSE_OPERATOR', 'VIEWER']) {
    const u = await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
    if (code === 'ADMIN') ctx.adminId = u._id;
  }

  const category = await Category.create({ tenantId: company._id, name: 'Fibre', code: 'FIB' });
  const warehouse = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });

  const bulk = await Product.create({
    tenantId: company._id, name: 'Fibre Cable', sku: 'OFC-1', productCode: 'PC-1',
    category: category._id, productType: 'NON_SERIALIZED', unitOfMeasure: 'MTR',
    reorderLevel: 500, reorderQuantity: 2000, maxStockLevel: 5000,
  });
  const serialized = await Product.create({
    tenantId: company._id, name: 'Server', sku: 'SRV-1', productCode: 'PC-2',
    category: category._id, productType: 'SERIALIZED',
  });

  ctx = { ...ctx, company, roles, tokens, category, warehouse, bulk, serialized };
});

const adjustBody = (over = {}) => ({
  product: String(ctx.bulk._id),
  warehouse: String(ctx.warehouse._id),
  newQuantity: 95,
  reasonCode: 'PHYSICAL_COUNT',
  remarks: 'Recount after cycle check',
  ...over,
});

describe('stock adjustments', () => {
  beforeEach(async () => { await giveStock(ctx.bulk._id, ctx.warehouse._id, 100); });

  it('writes the correction to the ledger', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.ADMIN)).send(adjustBody());

    expect(res.status).toBe(200);
    expect(res.body.data.quantityChange).toBe(-5);
    expect(res.body.data.quantityAfter).toBe(95);
    expect(res.body.data.reasonCode).toBe('PHYSICAL_COUNT');

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(95);
  });

  it('records every adjustment as CRITICAL in the audit log', async () => {
    await request(app).post('/api/v1/inventory/adjust').set(auth(ctx.tokens.ADMIN)).send(adjustBody());

    const entry = await AuditLog.findOne({ action: 'STOCK_ADJUSTED' });
    // This is the operation that can conjure stock from nothing; it is always
    // the highest severity regardless of size.
    expect(entry.severity).toBe('CRITICAL');
    expect(entry.changes[0]).toMatchObject({ before: 100, after: 95 });
    expect(entry.metadata.reasonCode).toBe('PHYSICAL_COUNT');
  });

  it('blocks a large adjustment for a manager without elevation', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send(adjustBody({ newQuantity: 0, remarks: 'Entire holding missing from rack R2' }));

    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe('ADJUSTMENT_LIMIT_EXCEEDED');

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(100);
  });

  it('allows the same adjustment for an admin', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.ADMIN))
      .send(adjustBody({ newQuantity: 0, remarks: 'Entire holding missing from rack R2' }));
    expect(res.status).toBe(200);
  });

  it('requires an explanation for a large adjustment', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.ADMIN)).send(adjustBody({ newQuantity: 0, remarks: 'gone' }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('REMARKS_REQUIRED');
  });

  it('rejects an unknown reason code before reaching the service', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.ADMIN)).send(adjustBody({ reasonCode: 'BECAUSE_I_SAID_SO' }));
    expect(res.status).toBe(400);
  });

  it('refuses to adjust a serialized product by quantity', async () => {
    await giveStock(ctx.serialized._id, ctx.warehouse._id, 5);

    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.ADMIN))
      .send(adjustBody({ product: String(ctx.serialized._id), newQuantity: 3 }));

    // Setting "available = 3" when five serials exist leaves the quantity and
    // the serial list disagreeing with no way to tell which two vanished.
    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('is denied to a warehouse operator entirely', async () => {
    const res = await request(app).post('/api/v1/inventory/adjust')
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR)).send(adjustBody());
    expect(res.status).toBe(403);
  });
});

describe('reclassification between buckets', () => {
  beforeEach(async () => { await giveStock(ctx.bulk._id, ctx.warehouse._id, 100); });

  it('moves stock without changing the total', async () => {
    const res = await request(app).post('/api/v1/inventory/reclassify')
      .set(auth(ctx.tokens.ADMIN))
      .send({
        product: String(ctx.bulk._id), warehouse: String(ctx.warehouse._id),
        fromBucket: 'AVAILABLE', toBucket: 'DAMAGED', quantity: 30,
        reasonCode: 'DAMAGE', remarks: 'Water damage in rack R1',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.direction).toBe('NEUTRAL');

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(70);
    expect(stock.damagedQuantity).toBe(30);
    // Total unchanged — this is a reclassification, not a correction.
    expect(stock.availableQuantity + stock.damagedQuantity).toBe(100);
  });

  it('refuses to move more than the source bucket holds', async () => {
    const res = await request(app).post('/api/v1/inventory/reclassify')
      .set(auth(ctx.tokens.ADMIN))
      .send({
        product: String(ctx.bulk._id), warehouse: String(ctx.warehouse._id),
        fromBucket: 'AVAILABLE', toBucket: 'DAMAGED', quantity: 500,
        reasonCode: 'DAMAGE',
      });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('INSUFFICIENT_STOCK');
  });

  it('refuses identical source and destination', async () => {
    const res = await request(app).post('/api/v1/inventory/reclassify')
      .set(auth(ctx.tokens.ADMIN))
      .send({
        product: String(ctx.bulk._id), warehouse: String(ctx.warehouse._id),
        fromBucket: 'AVAILABLE', toBucket: 'AVAILABLE', quantity: 5, reasonCode: 'DAMAGE',
      });
    expect(res.status).toBe(400);
  });
});

describe('physical stock counts', () => {
  beforeEach(async () => { await giveStock(ctx.bulk._id, ctx.warehouse._id, 100); });

  const createSheet = () => request(app).post('/api/v1/stock-counts')
    .set(auth(ctx.tokens.ADMIN))
    .send({ warehouse: String(ctx.warehouse._id), scope: 'FULL' });

  it('snapshots system quantities when the sheet is generated', async () => {
    const res = await createSheet();
    expect(res.status).toBe(201);
    expect(res.body.data.lines).toHaveLength(1); // serialized products excluded
    expect(res.body.data.lines[0].systemQuantity).toBe(100);
    expect(res.body.data.status).toBe('IN_PROGRESS');
  });

  it('does not absorb movements that happen during the count', async () => {
    const sheet = await createSheet();
    const lineId = sheet.body.data.lines[0].id;

    // Stock moves while the count is under way.
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 50);

    await request(app).patch(`/api/v1/stock-counts/${sheet.body.data.id}/counts`)
      .set(auth(ctx.tokens.ADMIN))
      .send({ entries: [{ lineId, countedQuantity: 100 }] });

    const count = await StockCount.findById(sheet.body.data.id);
    // Variance is measured against the snapshot (100), not against the live
    // figure (150) — otherwise the count would silently "explain" a
    // discrepancy it never measured.
    expect(count.lines[0].systemQuantity).toBe(100);
    expect(count.lines[0].variance).toBe(0);
  });

  it('posts variances to the ledger on completion', async () => {
    const sheet = await createSheet();
    const lineId = sheet.body.data.lines[0].id;

    await request(app).patch(`/api/v1/stock-counts/${sheet.body.data.id}/counts`)
      .set(auth(ctx.tokens.ADMIN))
      .send({ entries: [{ lineId, countedQuantity: 93, remarks: 'Short by 7 on the reel' }] });

    const res = await request(app).post(`/api/v1/stock-counts/${sheet.body.data.id}/complete`)
      .set(auth(ctx.tokens.ADMIN)).send({});

    expect(res.status).toBe(200);
    expect(res.body.data.summary.variances).toBe(1);

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(93);

    const entry = await InventoryTransaction.findOne({ reasonCode: 'PHYSICAL_COUNT' });
    expect(entry.quantityChange).toBe(-7);
    expect(entry.referenceNumber).toMatch(/^SC\//);
  });

  it('leaves uncounted lines completely untouched', async () => {
    const other = await Product.create({
      tenantId: ctx.company._id, name: 'Patch Cord', sku: 'PC-X', productCode: 'PC-X',
      category: ctx.category._id, productType: 'NON_SERIALIZED',
    });
    await giveStock(other._id, ctx.warehouse._id, 40);

    const sheet = await createSheet();
    const countedLine = sheet.body.data.lines.find((l) => l.product.sku === 'OFC-1');

    await request(app).patch(`/api/v1/stock-counts/${sheet.body.data.id}/counts`)
      .set(auth(ctx.tokens.ADMIN))
      .send({ entries: [{ lineId: countedLine.id, countedQuantity: 90 }] });

    const res = await request(app).post(`/api/v1/stock-counts/${sheet.body.data.id}/complete`)
      .set(auth(ctx.tokens.ADMIN)).send({});

    expect(res.body.data.summary.linesSkipped).toBe(1);

    // A line nobody counted is missing data, not evidence the stock is gone.
    // Writing it off would be the most destructive accident available here.
    const untouched = await Inventory.findOne({ product: other._id });
    expect(untouched.availableQuantity).toBe(40);
  });

  it('refuses a second open count on the same warehouse', async () => {
    await createSheet();
    const second = await createSheet();
    expect(second.status).toBe(409);
  });

  it('refuses completion with nothing counted', async () => {
    const sheet = await createSheet();
    const res = await request(app).post(`/api/v1/stock-counts/${sheet.body.data.id}/complete`)
      .set(auth(ctx.tokens.ADMIN)).send({});
    expect(res.status).toBe(422);
  });

  it('lets a manager run a count but not post it', async () => {
    const sheet = await request(app).post('/api/v1/stock-counts')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ warehouse: String(ctx.warehouse._id), scope: 'FULL' });
    expect(sheet.status).toBe(201);

    await request(app).patch(`/api/v1/stock-counts/${sheet.body.data.id}/counts`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ entries: [{ lineId: sheet.body.data.lines[0].id, countedQuantity: 10 }] })
      .expect(200);

    // Completing can post changes far beyond the per-adjustment ceiling, so it
    // needs the elevated permission.
    const res = await request(app).post(`/api/v1/stock-counts/${sheet.body.data.id}/complete`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).send({});
    expect(res.status).toBe(403);
  });
});

describe('reconciliation', () => {
  it('reports no drift on a healthy ledger', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);

    const res = await request(app).post('/api/v1/inventory/reconcile').set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
    expect(res.body.data.drift).toEqual([]);
  });

  it('detects stock written outside the ledger', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);

    // Simulates the bug the watchdog exists to catch: a direct write that
    // bypassed ledgerService. The ESLint rule makes this impossible in src/,
    // which is exactly why the test has to do it by hand.
    await Inventory.updateOne(
      { product: ctx.bulk._id, warehouse: ctx.warehouse._id },
      { $inc: { availableQuantity: 25 } },
    );

    const res = await request(app).post('/api/v1/inventory/reconcile').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data.drift).toHaveLength(1);
    expect(res.body.data.drift[0]).toMatchObject({
      ledgerTotal: 100, inventoryTotal: 125, difference: 25,
    });
  });

  it('does not silently repair drift', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);
    await Inventory.updateOne({ product: ctx.bulk._id }, { $inc: { availableQuantity: 25 } });

    await request(app).post('/api/v1/inventory/reconcile').set(auth(ctx.tokens.ADMIN));

    // Auto-correcting would make the symptom vanish each night while the cause
    // kept writing bad data.
    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(125);
  });

  it('raises a CRITICAL notification from the scheduled job', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);
    await Inventory.updateOne({ product: ctx.bulk._id }, { $inc: { availableQuantity: 25 } });

    const { runReconciliation } = await import('../../src/jobs/reconciliation.js');
    await runReconciliation();

    const alert = await Notification.findOne({ type: 'INVENTORY_DRIFT' });
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.recipientPermission).toBe('RECONCILE_INVENTORY');

    // Running again the same day must not duplicate the alert.
    await runReconciliation();
    expect(await Notification.countDocuments({ type: 'INVENTORY_DRIFT' })).toBe(1);
  });

  it('is denied to an inventory manager', async () => {
    const res = await request(app).post('/api/v1/inventory/reconcile')
      .set(auth(ctx.tokens.INVENTORY_MANAGER));
    expect(res.status).toBe(403);
  });
});

describe('low stock', () => {
  it('lists products at or below their reorder level with a suggested order', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 400); // reorder level is 500

    const res = await request(app).get('/api/v1/inventory/low-stock').set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ available: 400, reorderLevel: 500, outOfStock: false });
    // max(reorderQuantity 2000, maxStock 5000 − 400) = 4600
    expect(res.body.data[0].suggestedOrder).toBe(4600);
  });

  it('ignores products above their reorder level', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 4000);
    const res = await request(app).get('/api/v1/inventory/low-stock').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data).toHaveLength(0);
  });

  it('ignores products with no reorder level set', async () => {
    await Product.updateOne({ _id: ctx.bulk._id }, { reorderLevel: 0 });
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 1);

    // Zero means "not managed by reorder point", not "alert on everything".
    const res = await request(app).get('/api/v1/inventory/low-stock').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data).toHaveLength(0);
  });

  it('deduplicates alerts within a day', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);
    const { runLowStockScan } = await import('../../src/jobs/lowStock.js');

    await runLowStockScan();
    await runLowStockScan();
    await runLowStockScan();

    expect(await Notification.countDocuments({ type: 'LOW_STOCK' })).toBe(1);
  });
});

describe('notifications', () => {
  it('reaches users by the permission the alert is addressed to', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);
    await Inventory.updateOne({ product: ctx.bulk._id }, { $inc: { availableQuantity: 25 } });

    const { runReconciliation } = await import('../../src/jobs/reconciliation.js');
    await runReconciliation();

    const admin = await request(app).get('/api/v1/notifications').set(auth(ctx.tokens.ADMIN));
    expect(admin.body.data.some((n) => n.type === 'INVENTORY_DRIFT')).toBe(true);

    // The viewer holds no RECONCILE_INVENTORY permission, so the alert is not
    // theirs to see.
    const viewer = await request(app).get('/api/v1/notifications').set(auth(ctx.tokens.VIEWER));
    expect(viewer.body.data.some((n) => n.type === 'INVENTORY_DRIFT')).toBe(false);
  });

  it('marks notifications read', async () => {
    await giveStock(ctx.bulk._id, ctx.warehouse._id, 100);
    const { runLowStockScan } = await import('../../src/jobs/lowStock.js');
    await runLowStockScan();

    const before = await request(app).get('/api/v1/notifications').set(auth(ctx.tokens.ADMIN));
    expect(before.body.meta.unread).toBeGreaterThan(0);

    await request(app).post('/api/v1/notifications/read-all').set(auth(ctx.tokens.ADMIN)).expect(200);

    const after = await request(app).get('/api/v1/notifications').set(auth(ctx.tokens.ADMIN));
    expect(after.body.meta.unread).toBe(0);
  });
});

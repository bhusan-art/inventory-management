import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Inventory } from '../../src/models/Inventory.js';
import { InventoryTransaction } from '../../src/models/InventoryTransaction.js';
import { SerialNumber } from '../../src/models/SerialNumber.js';
import { totalSystemStock } from '../../src/services/transfer/transferService.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

async function giveStock(product, warehouse, quantity) {
  const { withTransaction } = await import('../../src/services/shared/transaction.js');
  const { applyMovement } = await import('../../src/services/inventory/ledgerService.js');
  await withTransaction(({ session }) => applyMovement({
    session, actor: { id: ctx.adminId, tenantId: ctx.company._id },
    product, warehouse, bucket: 'AVAILABLE', quantityChange: quantity,
    transactionType: 'PURCHASE_RECEIVED', referenceType: 'GRN',
  }));
}

async function giveSerials(product, warehouse, serials) {
  await giveStock(product, warehouse, serials.length);
  await SerialNumber.create(serials.map((serialNumber) => ({
    tenantId: ctx.company._id, serialNumber, product, warehouse, status: 'AVAILABLE',
  })));
}

const stockAt = async (product, warehouse) =>
  (await Inventory.findOne({ product, warehouse })) ?? { availableQuantity: 0, inTransitQuantity: 0, damagedQuantity: 0 };

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const blr = await Warehouse.create({ tenantId: company._id, name: 'Bengaluru', code: 'WH-BLR' });
  const transit = await Warehouse.create({
    tenantId: company._id, name: 'In Transit', code: 'TRANSIT', type: 'TRANSIT', isSystem: true,
  });

  const tokens = {};
  const users = [
    ['ADMIN', 'admin@test.local', []],
    ['SUPER_ADMIN', 'super@test.local', []],
    ['INVENTORY_MANAGER', 'manager@test.local', []],
    // Operators scoped to one end each — the realistic arrangement.
    ['WAREHOUSE_OPERATOR', 'hyd-op@test.local', [hyd._id]],
    ['WAREHOUSE_OPERATOR', 'blr-op@test.local', [blr._id]],
  ];
  for (const [role, email, warehouseIds] of users) {
    const u = await createUser({ company, role: roles[role], email, overrides: { scope: { warehouseIds } } });
    tokens[email] = (await signIn(email)).accessToken;
    if (role === 'ADMIN') ctx.adminId = u._id;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const cable = await Product.create({
    tenantId: company._id, name: 'Fibre Cable', sku: 'OFC-1', productCode: 'P1',
    category: category._id, productType: 'NON_SERIALIZED', unitOfMeasure: 'MTR',
  });
  const server = await Product.create({
    tenantId: company._id, name: 'Server', sku: 'SRV-1', productCode: 'P2',
    category: category._id, productType: 'SERIALIZED',
  });

  ctx = { ...ctx, company, roles, tokens, hyd, blr, transit, cable, server };
});

const t = (email) => auth(ctx.tokens[email]);

/** Creates by manager, approves by admin — two people, as the rules require. */
async function requestAndApprove(lines) {
  const created = await request(app).post('/api/v1/transfers').set(t('manager@test.local')).send({
    sourceWarehouse: String(ctx.hyd._id),
    destinationWarehouse: String(ctx.blr._id),
    lines,
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  await request(app).post(`/api/v1/transfers/${created.body.data.id}/approve`).set(t('admin@test.local')).expect(200);
  return created.body.data;
}

describe('conservation of stock (phase exit criterion)', () => {
  it('holds total stock constant at every stage of a transfer', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 1000);
    const total = () => totalSystemStock(ctx.company._id, ctx.cable._id);

    expect(await total()).toBe(1000);

    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 300 }]);
    expect(await total()).toBe(1000); // approval moves nothing

    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`)
      .set(t('hyd-op@test.local')).send({}).expect(200);

    // Mid-journey: stock is in neither warehouse, and still exactly 1000.
    expect(await total()).toBe(1000);
    expect((await stockAt(ctx.cable._id, ctx.hyd._id)).availableQuantity).toBe(700);
    expect((await stockAt(ctx.cable._id, ctx.transit._id)).inTransitQuantity).toBe(300);
    expect((await stockAt(ctx.cable._id, ctx.blr._id)).availableQuantity).toBe(0);

    await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 200 }] })
      .expect(200);

    // Partially received: 100 still on the truck, total unchanged.
    expect(await total()).toBe(1000);
    expect((await stockAt(ctx.cable._id, ctx.transit._id)).inTransitQuantity).toBe(100);

    await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 90, damagedQuantity: 10 }] })
      .expect(200);

    expect(await total()).toBe(1000);
    expect((await stockAt(ctx.cable._id, ctx.transit._id)).inTransitQuantity).toBe(0);
    expect((await stockAt(ctx.cable._id, ctx.blr._id)).availableQuantity).toBe(290);
    expect((await stockAt(ctx.cable._id, ctx.blr._id)).damagedQuantity).toBe(10);
  });

  it('writes four ledger rows for a full dispatch and receipt', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 100);
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 40 }]);

    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});
    await request(app).post(`/api/v1/transfers/${transfer.id}/receive`).set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 40 }] });

    const rows = await InventoryTransaction.find({ referenceType: 'TRANSFER' }).sort({ createdAt: 1 });
    expect(rows.map((r) => r.quantityChange)).toEqual([-40, 40, -40, 40]);

    // Signed changes sum to zero: nothing created, nothing destroyed.
    expect(rows.reduce((s, r) => s + r.quantityChange, 0)).toBe(0);
  });
});

describe('serialized transfers', () => {
  beforeEach(async () => {
    await giveSerials(ctx.server._id, ctx.hyd._id, ['SN-1', 'SN-2', 'SN-3']);
  });

  it('moves the exact serials selected, through IN_TRANSIT', async () => {
    const transfer = await requestAndApprove([{
      product: String(ctx.server._id), requestedQuantity: 2, serialNumbers: ['SN-1', 'SN-2'],
    }]);

    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    const inTransit = await SerialNumber.find({ status: 'IN_TRANSIT' }).sort({ serialNumber: 1 });
    expect(inTransit.map((s) => s.serialNumber)).toEqual(['SN-1', 'SN-2']);
    expect(String(inTransit[0].warehouse)).toBe(String(ctx.transit._id));

    const untouched = await SerialNumber.findOne({ serialNumber: 'SN-3' });
    expect(untouched.status).toBe('AVAILABLE');
  });

  it('records which serials arrived on a partial receipt', async () => {
    const transfer = await requestAndApprove([{
      product: String(ctx.server._id), requestedQuantity: 3, serialNumbers: ['SN-1', 'SN-2', 'SN-3'],
    }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedSerials: ['SN-1'], damagedSerials: ['SN-2'] }] });

    expect(res.body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(res.body.data.lines[0].pendingSerials).toEqual(['SN-3']);

    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('AVAILABLE');
    expect((await SerialNumber.findOne({ serialNumber: 'SN-2' })).status).toBe('DAMAGED');
    // Missing unit stays visibly in transit rather than silently vanishing.
    expect((await SerialNumber.findOne({ serialNumber: 'SN-3' })).status).toBe('IN_TRANSIT');
  });

  it('refuses a serial that was never on the transfer', async () => {
    const transfer = await requestAndApprove([{
      product: String(ctx.server._id), requestedQuantity: 1, serialNumbers: ['SN-1'],
    }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedSerials: ['SN-3'] }] });
    expect(res.status).toBe(422);
  });

  it('refuses to request a serial that is not available at the source', async () => {
    const res = await request(app).post('/api/v1/transfers').set(t('manager@test.local')).send({
      sourceWarehouse: String(ctx.hyd._id), destinationWarehouse: String(ctx.blr._id),
      lines: [{ product: String(ctx.server._id), requestedQuantity: 1, serialNumbers: ['SN-DOES-NOT-EXIST'] }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('SERIAL_NOT_AVAILABLE');
  });

  it('cannot send the same unit on two trucks', async () => {
    const a = await requestAndApprove([{ product: String(ctx.server._id), requestedQuantity: 1, serialNumbers: ['SN-1'] }]);
    const b = await requestAndApprove([{ product: String(ctx.server._id), requestedQuantity: 1, serialNumbers: ['SN-1'] }]);

    // Both were valid when requested. Only one can actually leave.
    await request(app).post(`/api/v1/transfers/${a.id}/dispatch`).set(t('hyd-op@test.local')).send({}).expect(200);
    const second = await request(app).post(`/api/v1/transfers/${b.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    expect(second.status).toBe(422);
    expect(await SerialNumber.countDocuments({ serialNumber: 'SN-1', status: 'IN_TRANSIT' })).toBe(1);
  });
});

describe('dispatch guards', () => {
  it('refuses to dispatch more than the source holds, and moves nothing', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 100);
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 80 }]);

    // Stock drops after the request was approved.
    const { withTransaction } = await import('../../src/services/shared/transaction.js');
    const { applyMovement } = await import('../../src/services/inventory/ledgerService.js');
    await withTransaction(({ session }) => applyMovement({
      session, actor: { id: ctx.adminId, tenantId: ctx.company._id },
      product: ctx.cable._id, warehouse: ctx.hyd._id, bucket: 'AVAILABLE',
      quantityChange: -50, transactionType: 'DISPATCH', referenceType: 'DISPATCH_NOTE',
    }));

    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`)
      .set(t('hyd-op@test.local')).send({});
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('INSUFFICIENT_STOCK');

    // Nothing reached transit.
    expect((await stockAt(ctx.cable._id, ctx.transit._id)).inTransitQuantity).toBe(0);
    expect((await stockAt(ctx.cable._id, ctx.hyd._id)).availableQuantity).toBe(50);
  });

  it('refuses to dispatch an unapproved transfer', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 100);
    const created = await request(app).post('/api/v1/transfers').set(t('manager@test.local')).send({
      sourceWarehouse: String(ctx.hyd._id), destinationWarehouse: String(ctx.blr._id),
      lines: [{ product: String(ctx.cable._id), requestedQuantity: 10 }],
    });

    const res = await request(app).post(`/api/v1/transfers/${created.body.data.id}/dispatch`)
      .set(t('hyd-op@test.local')).send({});
    expect(res.status).toBe(409);
  });

  it('refuses to dispatch twice', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 100);
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);

    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({}).expect(200);
    const again = await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});
    expect(again.status).toBe(409);
    expect((await stockAt(ctx.cable._id, ctx.hyd._id)).availableQuantity).toBe(90);
  });

  it('refuses a receipt larger than what is in transit', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 100);
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 15 }] });
    expect(res.status).toBe(422);
  });
});

describe('who may do what, and where', () => {
  beforeEach(async () => { await giveStock(ctx.cable._id, ctx.hyd._id, 100); });

  it('lets only the source end dispatch', async () => {
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);

    const wrongEnd = await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`)
      .set(t('blr-op@test.local')).send({});
    expect(wrongEnd.status).toBe(404);
  });

  it('lets only the destination end receive', async () => {
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    // Whoever loaded the truck must not be the one confirming it arrived.
    const wrongEnd = await request(app).post(`/api/v1/transfers/${transfer.id}/receive`)
      .set(t('hyd-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 10 }] });
    expect(wrongEnd.status).toBe(404);
  });

  it('blocks the requester from approving their own transfer', async () => {
    const created = await request(app).post('/api/v1/transfers').set(t('admin@test.local')).send({
      sourceWarehouse: String(ctx.hyd._id), destinationWarehouse: String(ctx.blr._id),
      lines: [{ product: String(ctx.cable._id), requestedQuantity: 10 }],
    });
    const res = await request(app).post(`/api/v1/transfers/${created.body.data.id}/approve`)
      .set(t('admin@test.local'));
    expect(res.status).toBe(422);
  });

  it('refuses the same source and destination', async () => {
    const res = await request(app).post('/api/v1/transfers').set(t('manager@test.local')).send({
      sourceWarehouse: String(ctx.hyd._id), destinationWarehouse: String(ctx.hyd._id),
      lines: [{ product: String(ctx.cable._id), requestedQuantity: 10 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a transfer ending at a system warehouse', async () => {
    const res = await request(app).post('/api/v1/transfers').set(t('manager@test.local')).send({
      sourceWarehouse: String(ctx.hyd._id), destinationWarehouse: String(ctx.transit._id),
      lines: [{ product: String(ctx.cable._id), requestedQuantity: 10 }],
    });
    expect(res.status).toBe(422);
  });
});

describe('cancellation', () => {
  beforeEach(async () => { await giveStock(ctx.cable._id, ctx.hyd._id, 100); });

  it('is allowed before dispatch and moves nothing', async () => {
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);
    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/cancel`)
      .set(t('manager@test.local')).send({ reason: 'Branch no longer needs it' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect((await stockAt(ctx.cable._id, ctx.hyd._id)).availableQuantity).toBe(100);
  });

  it('is refused once goods are on the move', async () => {
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 10 }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});

    const res = await request(app).post(`/api/v1/transfers/${transfer.id}/cancel`)
      .set(t('manager@test.local')).send({ reason: 'Changed our minds' });
    expect(res.status).toBe(422);
  });
});

describe('reconciliation after transfers', () => {
  it('finds no drift after a full transfer cycle', async () => {
    await giveStock(ctx.cable._id, ctx.hyd._id, 500);
    const transfer = await requestAndApprove([{ product: String(ctx.cable._id), requestedQuantity: 120 }]);
    await request(app).post(`/api/v1/transfers/${transfer.id}/dispatch`).set(t('hyd-op@test.local')).send({});
    await request(app).post(`/api/v1/transfers/${transfer.id}/receive`).set(t('blr-op@test.local'))
      .send({ lines: [{ lineId: transfer.lines[0].id, receivedQuantity: 100, damagedQuantity: 20 }] });

    const res = await request(app).post('/api/v1/inventory/reconcile').set(t('admin@test.local'));
    expect(res.body.data.drift).toEqual([]);
  });
});

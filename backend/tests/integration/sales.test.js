import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Customer } from '../../src/models/Customer.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Inventory } from '../../src/models/Inventory.js';
import { InventoryTransaction } from '../../src/models/InventoryTransaction.js';
import { SerialNumber } from '../../src/models/SerialNumber.js';
import { Warranty } from '../../src/models/Warranty.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

async function receive(product, serials, quantity) {
  const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
    vendor: String(ctx.vendor._id),
    warehouse: String(ctx.hyd._id),
    lines: [{
      product: String(product._id),
      receivedQuantity: quantity ?? serials.length,
      acceptedQuantity: quantity ?? serials.length,
      serialNumbers: serials ?? [],
    }],
  });
  await request(app).post(`/api/v1/grn/${created.body.data.id}/post`).set(auth(ctx.tokens.ADMIN)).expect(200);
}

const stock = async (product) =>
  (await Inventory.findOne({ product: product._id, warehouse: ctx.hyd._id }))
  ?? { availableQuantity: 0, reservedQuantity: 0 };

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'SALES_DISPATCH', 'INVENTORY_MANAGER', 'WAREHOUSE_OPERATOR', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const vendor = await Vendor.create({ tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL' });
  const customer = await Customer.create({
    tenantId: company._id, customerName: 'ACME Technologies', customerCode: 'C-ACME',
  });

  const server = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'P1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36,
  });
  const cable = await Product.create({
    tenantId: company._id, name: 'Fibre Cable', sku: 'OFC-1', productCode: 'P2',
    category: category._id, productType: 'NON_SERIALIZED', unitOfMeasure: 'MTR',
  });

  ctx = { company, roles, tokens, category, hyd, vendor, customer, server, cable };
});

const orderBody = (lines) => ({
  customer: String(ctx.customer._id),
  warehouse: String(ctx.hyd._id),
  lines,
});

async function createAndConfirm(lines, body = {}) {
  const created = await request(app).post('/api/v1/sales-orders')
    .set(auth(ctx.tokens.SALES_DISPATCH)).send(orderBody(lines));
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));

  const confirmed = await request(app).post(`/api/v1/sales-orders/${created.body.data.id}/confirm`)
    .set(auth(ctx.tokens.SALES_DISPATCH)).send(body);
  return { created: created.body.data, confirmed };
}

describe('reservation', () => {
  it('moves stock from available to reserved without changing the total', async () => {
    await receive(ctx.cable, [], 1000);

    const { confirmed } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('CONFIRMED');

    const after = await stock(ctx.cable);
    expect(after.availableQuantity).toBe(700);
    expect(after.reservedQuantity).toBe(300);
    // Nothing has physically left yet.
    expect(after.availableQuantity + after.reservedQuantity).toBe(1000);
  });

  it('claims specific serial numbers', async () => {
    await receive(ctx.server, ['SN-1', 'SN-2', 'SN-3']);

    const { confirmed } = await createAndConfirm([{ product: String(ctx.server._id), orderedQuantity: 2 }]);

    const reserved = await SerialNumber.find({ status: 'RESERVED' }).sort({ serialNumber: 1 });
    expect(reserved).toHaveLength(2);
    expect(confirmed.body.data.lines[0].reservedSerialNumbers).toHaveLength(2);

    const untouched = await SerialNumber.findOne({ status: 'AVAILABLE' });
    expect(untouched).toBeTruthy();
  });

  it('honours an explicit serial selection', async () => {
    await receive(ctx.server, ['SN-1', 'SN-2', 'SN-3']);

    const created = await request(app).post('/api/v1/sales-orders')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.server._id), orderedQuantity: 1 }]));

    const res = await request(app).post(`/api/v1/sales-orders/${created.body.data.id}/confirm`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ serialSelections: [{ lineId: created.body.data.lines[0].id, serialNumbers: ['SN-3'] }] });

    expect(res.status).toBe(200);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-3' })).status).toBe('RESERVED');
    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('AVAILABLE');
  });

  it('refuses to reserve more than is available, and moves nothing', async () => {
    await receive(ctx.cable, [], 100);

    const created = await request(app).post('/api/v1/sales-orders')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 500 }]));

    const res = await request(app).post(`/api/v1/sales-orders/${created.body.data.id}/confirm`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({});

    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('INSUFFICIENT_STOCK');

    const after = await stock(ctx.cable);
    expect(after.availableQuantity).toBe(100);
    expect(after.reservedQuantity).toBe(0);
  });

  it('lets only one of two concurrent confirmations claim the last units', async () => {
    await receive(ctx.cable, [], 10);

    const a = await request(app).post('/api/v1/sales-orders').set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 10 }]));
    const b = await request(app).post('/api/v1/sales-orders').set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 10 }]));

    const results = await Promise.allSettled([
      request(app).post(`/api/v1/sales-orders/${a.body.data.id}/confirm`).set(auth(ctx.tokens.SALES_DISPATCH)).send({}),
      request(app).post(`/api/v1/sales-orders/${b.body.data.id}/confirm`).set(auth(ctx.tokens.SALES_DISPATCH)).send({}),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
    expect(succeeded).toHaveLength(1);

    const after = await stock(ctx.cable);
    expect(after.reservedQuantity).toBe(10);
    expect(after.availableQuantity).toBe(0);
  });

  it('releases a reservation back to available', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    await request(app).post(`/api/v1/sales-orders/${created.id}/release`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ reason: 'Customer deferred the order' })
      .expect(200);

    const after = await stock(ctx.cable);
    expect(after.availableQuantity).toBe(1000);
    expect(after.reservedQuantity).toBe(0);
  });

  it('returns reserved serials to available on release', async () => {
    await receive(ctx.server, ['SN-1', 'SN-2']);
    const { created } = await createAndConfirm([{ product: String(ctx.server._id), orderedQuantity: 2 }]);

    await request(app).post(`/api/v1/sales-orders/${created.id}/release`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ reason: 'Order withdrawn by customer' });

    expect(await SerialNumber.countDocuments({ status: 'AVAILABLE' })).toBe(2);
    expect(await SerialNumber.countDocuments({ status: 'RESERVED' })).toBe(0);
  });
});

describe('dispatch', () => {
  it('ships reserved stock and creates a warranty per unit', async () => {
    await receive(ctx.server, ['SN-1', 'SN-2']);
    const { created, confirmed } = await createAndConfirm([
      { product: String(ctx.server._id), orderedQuantity: 2 },
    ]);
    const serials = confirmed.body.data.lines[0].reservedSerialNumbers;

    const res = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id),
      warehouse: String(ctx.hyd._id),
      salesOrder: created.id,
      dispatchDate: '2026-09-10',
      lines: [{ product: String(ctx.server._id), quantity: 2, serialNumbers: serials }],
    });

    expect(res.status).toBe(201);

    const after = await stock(ctx.server);
    expect(after.availableQuantity).toBe(0);
    expect(after.reservedQuantity).toBe(0);

    const dispatched = await SerialNumber.find({ status: 'DISPATCHED' });
    expect(dispatched).toHaveLength(2);
    expect(String(dispatched[0].customer)).toBe(String(ctx.customer._id));
    expect(dispatched[0].warehouse).toBeNull();

    const warranties = await Warranty.find({});
    expect(warranties).toHaveLength(2);
    // 2026-09-10 + 36 months.
    expect(warranties[0].endDate.toISOString().slice(0, 10)).toBe('2029-09-10');
    expect(warranties[0].durationMonths).toBe(36);
  });

  it('writes a DISPATCH ledger row out of the reserved bucket', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 300 }],
    }).expect(201);

    const row = await InventoryTransaction.findOne({ transactionType: 'DISPATCH' });
    expect(row.quantityChange).toBe(-300);
    expect(row.direction).toBe('OUT');
    // Confirm already took it out of available; dispatch takes it out of reserved.
    expect(row.bucketFrom).toBe('RESERVED');
  });

  it('does not decrement available twice', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 300 }],
    }).expect(201);

    const after = await stock(ctx.cable);
    // 1000 − 300 = 700, not 400.
    expect(after.availableQuantity).toBe(700);
    expect(after.reservedQuantity).toBe(0);
  });

  it('supports partial dispatch and tracks the balance', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    const first = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 200 }],
    });
    expect(first.status).toBe(201);

    const order = await request(app).get(`/api/v1/sales-orders/${created.id}`).set(auth(ctx.tokens.SALES_DISPATCH));
    expect(order.body.data.status).toBe('PARTIALLY_DISPATCHED');
    expect(order.body.data.totals.outstanding).toBe(100);

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 100 }],
    }).expect(201);

    const closed = await request(app).get(`/api/v1/sales-orders/${created.id}`).set(auth(ctx.tokens.SALES_DISPATCH));
    expect(closed.body.data.status).toBe('DISPATCHED');
  });

  it('refuses to dispatch more than is outstanding', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    const res = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 400 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('OVER_DISPATCH_EXCEEDED');
  });

  it('refuses a serial that is not reserved for this order', async () => {
    await receive(ctx.server, ['SN-1', 'SN-2', 'SN-3']);
    const { created, confirmed } = await createAndConfirm([
      { product: String(ctx.server._id), orderedQuantity: 1 },
    ]);
    const reserved = confirmed.body.data.lines[0].reservedSerialNumbers[0];
    const other = ['SN-1', 'SN-2', 'SN-3'].find((s) => s !== reserved);

    const res = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.server._id), quantity: 1, serialNumbers: [other] }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('cannot dispatch the same unit twice', async () => {
    await receive(ctx.server, ['SN-1']);
    const { created, confirmed } = await createAndConfirm([
      { product: String(ctx.server._id), orderedQuantity: 1 },
    ]);
    const serials = confirmed.body.data.lines[0].reservedSerialNumbers;

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.server._id), quantity: 1, serialNumbers: serials }],
    }).expect(201);

    // Direct, without an order — the transition table is the backstop.
    const second = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id),
      lines: [{ product: String(ctx.server._id), quantity: 1, serialNumbers: serials }],
    });

    expect(second.status).toBe(422);
    expect(await SerialNumber.countDocuments({ status: 'DISPATCHED' })).toBe(1);
  });

  it('is idempotent under a retried request', async () => {
    await receive(ctx.cable, [], 1000);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 300 }]);

    const body = {
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 300 }],
    };

    const first = await request(app).post('/api/v1/dispatch-notes')
      .set(auth(ctx.tokens.SALES_DISPATCH)).set('Idempotency-Key', 'retry-abc').send(body);
    const second = await request(app).post('/api/v1/dispatch-notes')
      .set(auth(ctx.tokens.SALES_DISPATCH)).set('Idempotency-Key', 'retry-abc').send(body);

    expect(first.status).toBe(201);
    // Same note returned, goods shipped once.
    expect(second.body.data.dispatchNoteNumber).toBe(first.body.data.dispatchNoteNumber);
    expect(await mongoose.model('DispatchNote').countDocuments({})).toBe(1);
    expect((await stock(ctx.cable)).availableQuantity).toBe(700);
  });

  it('records the dispatch as CRITICAL', async () => {
    await receive(ctx.cable, [], 100);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 10 }]);

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 10 }],
    });

    const entry = await AuditLog.findOne({ action: 'GOODS_DISPATCHED' });
    expect(entry.severity).toBe('CRITICAL');
  });
});

describe('dispatch cancellation', () => {
  it('returns stock and voids the warranty', async () => {
    await receive(ctx.server, ['SN-1']);
    const { created, confirmed } = await createAndConfirm([
      { product: String(ctx.server._id), orderedQuantity: 1 },
    ]);
    const serials = confirmed.body.data.lines[0].reservedSerialNumbers;

    const note = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.server._id), quantity: 1, serialNumbers: serials }],
    });

    const res = await request(app).post(`/api/v1/dispatch-notes/${note.body.data.id}/cancel`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ reason: 'Loaded onto the wrong vehicle' });

    expect(res.status).toBe(200);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(serial.status).toBe('RESERVED');
    expect(serial.customer).toBeNull();

    // The goods never reached the customer, so the cover never started.
    const warranty = await Warranty.findOne({});
    expect(warranty.state).toBe('VOID');
  });

  it('refuses once the goods are delivered', async () => {
    await receive(ctx.cable, [], 100);
    const { created } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 10 }]);

    const note = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      lines: [{ product: String(ctx.cable._id), quantity: 10 }],
    });

    await request(app).post(`/api/v1/dispatch-notes/${note.body.data.id}/deliver`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ receivedByName: 'R Kumar' }).expect(200);

    const res = await request(app).post(`/api/v1/dispatch-notes/${note.body.data.id}/cancel`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ reason: 'Changed our minds' });

    // The customer has the goods; the honest route is a return.
    expect(res.status).toBe(422);
  });
});

describe('customer assets', () => {
  it('lists what the customer holds with live warranty state', async () => {
    await receive(ctx.server, ['SN-1']);
    const { created, confirmed } = await createAndConfirm([
      { product: String(ctx.server._id), orderedQuantity: 1 },
    ]);

    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: created.id,
      dispatchDate: new Date().toISOString(),
      lines: [{
        product: String(ctx.server._id), quantity: 1,
        serialNumbers: confirmed.body.data.lines[0].reservedSerialNumbers,
      }],
    }).expect(201);

    const res = await request(app)
      .get(`/api/v1/dispatch-notes/customer/${ctx.customer._id}/assets`)
      .set(auth(ctx.tokens.SALES_DISPATCH));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].serialNumber).toBe('SN-1');
    expect(res.body.data[0].warranty.status).toBe('ACTIVE');
    expect(res.body.data[0].warranty.daysRemaining).toBeGreaterThan(1000);
  });
});

describe('permissions and guards', () => {
  it('refuses a customer on hold', async () => {
    await Customer.updateOne({ _id: ctx.customer._id }, { status: 'ON_HOLD' });
    const res = await request(app).post('/api/v1/sales-orders').set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 10 }]));
    expect(res.status).toBe(422);
  });

  it('does not let an inventory manager confirm an order', async () => {
    await receive(ctx.cable, [], 100);
    const created = await request(app).post('/api/v1/sales-orders').set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 10 }]));

    const res = await request(app).post(`/api/v1/sales-orders/${created.body.data.id}/confirm`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).send({});
    expect(res.status).toBe(403);
  });

  it('does not let a viewer dispatch', async () => {
    const res = await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.VIEWER)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id),
      lines: [{ product: String(ctx.cable._id), quantity: 1 }],
    });
    expect(res.status).toBe(403);
  });

  it('refuses a discontinued product', async () => {
    await Product.updateOne({ _id: ctx.cable._id }, { status: 'DISCONTINUED' });
    const res = await request(app).post('/api/v1/sales-orders').set(auth(ctx.tokens.SALES_DISPATCH))
      .send(orderBody([{ product: String(ctx.cable._id), orderedQuantity: 10 }]));
    expect(res.status).toBe(422);
  });
});

describe('reconciliation after a full sales cycle', () => {
  it('finds no drift', async () => {
    await receive(ctx.cable, [], 1000);
    await receive(ctx.server, ['SN-1', 'SN-2']);

    const { created: cableOrder } = await createAndConfirm([{ product: String(ctx.cable._id), orderedQuantity: 400 }]);
    await request(app).post('/api/v1/dispatch-notes').set(auth(ctx.tokens.SALES_DISPATCH)).send({
      customer: String(ctx.customer._id), warehouse: String(ctx.hyd._id), salesOrder: cableOrder.id,
      lines: [{ product: String(ctx.cable._id), quantity: 400 }],
    });

    const res = await request(app).post('/api/v1/inventory/reconcile').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data.drift).toEqual([]);
  });
});

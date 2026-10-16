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
import { CustomerReturn } from '../../src/models/CustomerReturn.js';
import { VendorReturn } from '../../src/models/VendorReturn.js';
import {
  app, resetDatabase, seedTenant, createUser, signIn, auth, retryOnConflict,
} from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

async function receive(serials, quantity) {
  const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
    vendor: String(ctx.vendor._id),
    warehouse: String(ctx.hyd._id),
    lines: [{
      product: String(serials ? ctx.server._id : ctx.cable._id),
      receivedQuantity: quantity ?? serials.length,
      acceptedQuantity: quantity ?? serials.length,
      serialNumbers: serials ?? [],
    }],
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  await request(app).post(`/api/v1/grn/${created.body.data.id}/post`)
    .set(auth(ctx.tokens.ADMIN)).expect(200);
}

/** Takes units to the customer, which is the precondition for any return. */
async function sellTo(serials) {
  const order = await request(app).post('/api/v1/sales-orders')
    .set(auth(ctx.tokens.SALES_DISPATCH))
    .send({
      customer: String(ctx.customer._id),
      warehouse: String(ctx.hyd._id),
      lines: [{ product: String(ctx.server._id), orderedQuantity: serials.length }],
    });
  if (order.status !== 201) throw new Error(JSON.stringify(order.body));

  const confirmed = await request(app).post(`/api/v1/sales-orders/${order.body.data.id}/confirm`)
    .set(auth(ctx.tokens.SALES_DISPATCH))
    .send({ serialSelections: [{ lineId: order.body.data.lines[0].id, serialNumbers: serials }] });
  if (confirmed.status !== 200) throw new Error(JSON.stringify(confirmed.body));

  const note = await retryOnConflict(() => request(app).post('/api/v1/dispatch-notes')
    .set(auth(ctx.tokens.SALES_DISPATCH))
    .send({
      customer: String(ctx.customer._id),
      warehouse: String(ctx.hyd._id),
      salesOrder: order.body.data.id,
      dispatchDate: '2026-09-10',
      lines: [{ product: String(ctx.server._id), quantity: serials.length, serialNumbers: serials }],
    }));
  if (note.status !== 201) throw new Error(JSON.stringify(note.body));
  return note.body.data;
}

const bucketsOf = async (product = ctx.server) => {
  const row = await Inventory.findOne({ product: product._id, warehouse: ctx.hyd._id });
  return {
    available: row?.availableQuantity ?? 0,
    damaged: row?.damagedQuantity ?? 0,
    reserved: row?.reservedQuantity ?? 0,
    total: (row?.availableQuantity ?? 0) + (row?.damagedQuantity ?? 0) + (row?.reservedQuantity ?? 0),
  };
};

/** Raises a return request, approves it, and returns the document. */
async function approvedReturn(body = {}) {
  const createdRes = await request(app).post('/api/v1/customer-returns')
    .set(auth(ctx.tokens.SALES_DISPATCH))
    .send({
      customer: String(ctx.customer._id),
      warehouse: String(ctx.hyd._id),
      reason: 'DEFECTIVE',
      lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      ...body,
    });
  if (createdRes.status !== 201) throw new Error(JSON.stringify(createdRes.body));

  await request(app).post(`/api/v1/customer-returns/${createdRes.body.data.id}/status`)
    .set(auth(ctx.tokens.ADMIN)).send({ status: 'PENDING_APPROVAL' }).expect(200);
  const approved = await request(app).post(`/api/v1/customer-returns/${createdRes.body.data.id}/status`)
    .set(auth(ctx.tokens.ADMIN)).send({ status: 'APPROVED' });
  if (approved.status !== 200) throw new Error(JSON.stringify(approved.body));

  return approved.body.data;
}

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'SALES_DISPATCH', 'WAREHOUSE_OPERATOR', 'INVENTORY_MANAGER', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const vendor = await Vendor.create({ tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL' });
  const customer = await Customer.create({
    tenantId: company._id, customerName: 'ACME Technologies', customerCode: 'C-ACME',
  });
  const other = await Customer.create({
    tenantId: company._id, customerName: 'Globex Limited', customerCode: 'C-GLOBEX',
  });

  const server = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'P1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36,
  });
  const cable = await Product.create({
    tenantId: company._id, name: 'Fibre Cable', sku: 'OFC-1', productCode: 'P2',
    category: category._id, productType: 'NON_SERIALIZED', unitOfMeasure: 'MTR',
  });

  ctx = { company, roles, tokens, category, hyd, vendor, customer, other, server, cable };
});

describe('raising a return', () => {
  it('moves no stock — the goods are still with the customer', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const before = await bucketsOf();

    await approvedReturn();

    expect(await bucketsOf()).toEqual(before);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('DISPATCHED');
  });

  it('refuses to return more than was dispatched on the named note', async () => {
    await receive(['SN-1', 'SN-2']);
    const note = await sellTo(['SN-1']);

    const res = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        dispatchNote: note.id,
        reason: 'DEFECTIVE',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 5 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RETURN_EXCEEDS_DISPATCHED');
  });

  it('accepts a return with no dispatch note at all', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    // A customer returning a unit years later may not have the paperwork.
    // Our missing reference should not become their problem.
    const res = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        reason: 'END_OF_LIFE_RETURN',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.dispatchNote).toBeNull();
  });

  it('rejects a dispatch note belonging to another customer', async () => {
    await receive(['SN-1']);
    const note = await sellTo(['SN-1']);

    const res = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.other._id),
        warehouse: String(ctx.hyd._id),
        dispatchNote: note.id,
        reason: 'DEFECTIVE',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DISPATCH_CUSTOMER_MISMATCH');
  });
});

describe('receiving returned goods', () => {
  it('quarantines them in DAMAGED, never AVAILABLE', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
      .expect(200);

    expect(res.body.data.status).toBe('RECEIVED');

    // The whole point: condition is unknown, so it is not sellable.
    const buckets = await bucketsOf();
    expect(buckets.damaged).toBe(1);
    expect(buckets.available).toBe(0);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(serial.status).toBe('RETURNED_BY_CUSTOMER');
    expect(serial.customer).toBeNull();

    const row = await InventoryTransaction.findOne({ transactionType: 'CUSTOMER_RETURN' });
    expect(row.quantityChange).toBe(1);
    expect(row.bucketTo).toBe('DAMAGED');
  });

  it('voids the warranty, because the customer no longer has the unit', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    expect((await Warranty.findOne({})).state).toBe('ACTIVE');

    const ret = await approvedReturn();
    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
      .expect(200);

    const warranty = await Warranty.findOne({});
    expect(warranty.state).toBe('VOID');
    // Traceable to this return, not an unexplained void.
    expect(warranty.voidReason).toContain(ret.returnNumber);
    expect(res.body.data.warrantiesVoidedCount).toBe(1);
  });

  it('will not receive goods for a return nobody approved', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    const draft = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        reason: 'DEFECTIVE',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      });

    const res = await request(app).post(`/api/v1/customer-returns/${draft.body.data.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: draft.body.data.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RETURN_NOT_APPROVED');
    expect((await bucketsOf()).damaged).toBe(0);
  });

  it('records a shortfall when the customer sends fewer than they claimed', async () => {
    await receive(['SN-1', 'SN-2', 'SN-3']);
    await sellTo(['SN-1', 'SN-2', 'SN-3']);
    const ret = await approvedReturn({
      lines: [{ product: String(ctx.server._id), requestedQuantity: 3 }],
    });

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 2, serialNumbers: ['SN-1', 'SN-2'] }] })
      .expect(200);

    const line = res.body.data.lines[0];
    expect(line.requestedQuantity).toBe(3);
    expect(line.receivedQuantity).toBe(2);
    // Claimed three, sent two. Both numbers survive.
    expect(line.shortfall).toBe(1);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-3' })).status).toBe('DISPATCHED');
  });

  it('refuses to receive more than was authorised', async () => {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1', 'SN-2']);
    const ret = await approvedReturn();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 2, serialNumbers: ['SN-1', 'SN-2'] }] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RECEIPT_EXCEEDS_AUTHORISED');
  });

  it('refuses a unit issued to a different customer', async () => {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();

    // SN-2 never left the warehouse, so it is not this customer's to return.
    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-2'] }] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await bucketsOf()).damaged).toBe(0);
  });

  it('is idempotent under a repeated receipt', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();
    const body = { lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] };

    const first = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR)).set('Idempotency-Key', 'rcv-1').send(body).expect(200);
    const second = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR)).set('Idempotency-Key', 'rcv-1').send(body).expect(200);

    expect(second.body.data.id).toBe(first.body.data.id);
    // One receipt, one unit — not two.
    expect((await bucketsOf()).damaged).toBe(1);
    expect(await InventoryTransaction.countDocuments({ transactionType: 'CUSTOMER_RETURN' })).toBe(1);
  });

  it('handles bulk stock with no serial numbers', async () => {
    await receive(null, 500);

    const createdRes = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        reason: 'EXCESS_DELIVERY',
        lines: [{ product: String(ctx.cable._id), requestedQuantity: 100 }],
      }).expect(201);

    const id = createdRes.body.data.id;
    await request(app).post(`/api/v1/customer-returns/${id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'PENDING_APPROVAL' }).expect(200);
    await request(app).post(`/api/v1/customer-returns/${id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'APPROVED' }).expect(200);

    await request(app).post(`/api/v1/customer-returns/${id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: createdRes.body.data.lines[0].id, receivedQuantity: 100 }] })
      .expect(200);

    const cable = await bucketsOf(ctx.cable);
    expect(cable.damaged).toBe(100);
    expect(cable.available).toBe(500);
  });
});

describe('disposition', () => {
  async function received(serials = ['SN-1']) {
    await receive(serials);
    await sellTo(serials);
    const ret = await approvedReturn({
      lines: [{ product: String(ctx.server._id), requestedQuantity: serials.length }],
    });
    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: serials.length, serialNumbers: serials }] })
      .expect(200);
    return res.body.data;
  }

  it('RESTOCK moves DAMAGED → AVAILABLE and keeps the total unchanged', async () => {
    const ret = await received();
    const before = await bucketsOf();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        lineId: ret.lines[0].id,
        disposition: 'RESTOCK',
        quantity: 1,
        serialNumbers: ['SN-1'],
        inspectionNotes: 'Tested, no fault found',
      })
      .expect(200);

    const after = await bucketsOf();
    expect(after.available).toBe(1);
    expect(after.damaged).toBe(0);
    // Nothing entered or left; it only changed bucket.
    expect(after.total).toBe(before.total);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(serial.status).toBe('AVAILABLE');
    expect(serial.condition).toBe('REFURBISHED');
    expect(res.body.data.lines[0].pendingQuantity).toBe(0);
  });

  it('SCRAP takes the unit out of stock entirely', async () => {
    const ret = await received();

    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        lineId: ret.lines[0].id,
        disposition: 'SCRAP',
        quantity: 1,
        serialNumbers: ['SN-1'],
        inspectionNotes: 'Water damage, beyond repair',
      })
      .expect(200);

    const after = await bucketsOf();
    expect(after.damaged).toBe(0);
    expect(after.available).toBe(0);
    expect(after.total).toBe(0);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(serial.status).toBe('SCRAPPED');
    expect(serial.warehouse).toBeNull();

    const row = await InventoryTransaction.findOne({ transactionType: 'SCRAP' });
    expect(row.quantityChange).toBe(-1);
  });

  it('QUARANTINE records the decision without moving anything', async () => {
    const ret = await received();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        lineId: ret.lines[0].id,
        disposition: 'QUARANTINE',
        quantity: 1,
        serialNumbers: ['SN-1'],
        inspectionNotes: 'Holding pending vendor advice',
      })
      .expect(200);

    expect((await bucketsOf()).damaged).toBe(1);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('DAMAGED');
    // "Decided to hold" is not the same as "not decided yet".
    expect(res.body.data.lines[0].pendingQuantity).toBe(0);
    expect(res.body.data.lines[0].dispositions[0].disposition).toBe('QUARANTINE');
  });

  it('RETURN_TO_VENDOR leaves the stock where it is — the goods have not moved', async () => {
    const ret = await received();

    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        lineId: ret.lines[0].id, disposition: 'RETURN_TO_VENDOR', quantity: 1, serialNumbers: ['SN-1'],
      })
      .expect(200);

    // Still in our building, so still in our stock. Taking it out here would
    // leave the ledger and the serial disagreeing.
    expect((await bucketsOf()).damaged).toBe(1);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('DAMAGED');
  });

  it('splits one line across several dispositions', async () => {
    const ret = await received(['SN-1', 'SN-2', 'SN-3']);
    const lineId = ret.lines[0].id;

    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-1'] }).expect(200);
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId, disposition: 'SCRAP', quantity: 1, serialNumbers: ['SN-2'] }).expect(200);
    const last = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId, disposition: 'QUARANTINE', quantity: 1, serialNumbers: ['SN-3'] }).expect(200);

    const after = await bucketsOf();
    expect(after.available).toBe(1);   // restocked
    expect(after.damaged).toBe(1);     // quarantined
    expect(after.total).toBe(2);       // one scrapped and gone
    expect(last.body.data.lines[0].pendingQuantity).toBe(0);
    expect(last.body.data.lines[0].dispositions).toHaveLength(3);
  });

  it('refuses to disposition more than arrived', async () => {
    const ret = await received();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 5 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DISPOSITION_EXCEEDS_PENDING');
  });

  it('refuses a serial that did not arrive on this return', async () => {
    await receive(['SN-9']);
    const ret = await received();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-9'],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERIAL_NOT_ON_RETURN');
  });

  it('will not set a disposition before the goods arrive', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 1 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RETURN_NOT_RECEIVED');
  });

  it('refuses to close while stock still awaits a decision', async () => {
    const ret = await received();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'CLOSED' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DISPOSITION_PENDING');
    // Nothing stranded: the unit is still visibly in quarantine.
    expect((await bucketsOf()).damaged).toBe(1);
  });

  it('closes once everything has been decided', async () => {
    const ret = await received();
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-1'] })
      .expect(200);

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'CLOSED' }).expect(200);

    expect(res.body.data.status).toBe('CLOSED');
  });

  it('lists what is waiting to be inspected', async () => {
    await received();

    const res = await request(app).get('/api/v1/customer-returns/disposition-queue')
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].pendingDisposition).toBe(1);
  });
});

describe('vendor returns', () => {
  async function damagedStock() {
    // A GRN that accepts fewer than received puts the rest in DAMAGED.
    const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
      vendor: String(ctx.vendor._id),
      warehouse: String(ctx.hyd._id),
      lines: [{
        product: String(ctx.cable._id),
        receivedQuantity: 100,
        acceptedQuantity: 90,
        damagedQuantity: 10,
      }],
    });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    await request(app).post(`/api/v1/grn/${created.body.data.id}/post`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);
  }

  async function draftRtv(body = {}) {
    const res = await request(app).post('/api/v1/vendor-returns')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        vendor: String(ctx.vendor._id),
        warehouse: String(ctx.hyd._id),
        reason: 'DEFECTIVE_ON_ARRIVAL',
        lines: [{ product: String(ctx.cable._id), quantity: 10, sourceBucket: 'DAMAGED' }],
        ...body,
      });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.data;
  }

  it('drafts without moving stock', async () => {
    await damagedStock();
    const before = await bucketsOf(ctx.cable);

    const rtv = await draftRtv();

    expect(rtv.status).toBe('DRAFT');
    // A document being prepared must not make the shelf lie.
    expect(await bucketsOf(ctx.cable)).toEqual(before);
  });

  it('sends the goods and takes them out of the named bucket', async () => {
    await damagedStock();
    const rtv = await draftRtv();

    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'PENDING_APPROVAL' }).expect(200);
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'APPROVED' }).expect(200);

    const res = await request(app).post(`/api/v1/vendor-returns/${rtv.id}/send`)
      .set(auth(ctx.tokens.ADMIN))
      .send({ courier: 'Blue Dart', trackingNumber: 'BD-99001' })
      .expect(200);

    expect(res.body.data.status).toBe('SENT');
    expect(res.body.data.trackingNumber).toBe('BD-99001');

    const after = await bucketsOf(ctx.cable);
    expect(after.damaged).toBe(0);
    expect(after.available).toBe(90);

    const row = await InventoryTransaction.findOne({ transactionType: 'VENDOR_RETURN' });
    expect(row.quantityChange).toBe(-10);
    expect(row.bucketFrom).toBe('DAMAGED');
  });

  it('will not send goods nobody approved', async () => {
    await damagedStock();
    const rtv = await draftRtv();

    const res = await request(app).post(`/api/v1/vendor-returns/${rtv.id}/send`)
      .set(auth(ctx.tokens.ADMIN)).send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RETURN_NOT_APPROVED');
    expect((await bucketsOf(ctx.cable)).damaged).toBe(10);
  });

  it('refuses a draft for more than the bucket holds', async () => {
    await damagedStock();

    const res = await request(app).post('/api/v1/vendor-returns')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({
        vendor: String(ctx.vendor._id),
        warehouse: String(ctx.hyd._id),
        reason: 'DEFECTIVE_ON_ARRIVAL',
        lines: [{ product: String(ctx.cable._id), quantity: 50, sourceBucket: 'DAMAGED' }],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('can send good stock back as an over-delivery', async () => {
    await damagedStock();

    const rtv = await draftRtv({
      reason: 'EXCESS_RECEIVED',
      lines: [{ product: String(ctx.cable._id), quantity: 20, sourceBucket: 'AVAILABLE' }],
    });
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'PENDING_APPROVAL' }).expect(200);
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'APPROVED' }).expect(200);
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/send`)
      .set(auth(ctx.tokens.ADMIN)).send({}).expect(200);

    const after = await bucketsOf(ctx.cable);
    // Good stock left AVAILABLE; the damaged units are untouched.
    expect(after.available).toBe(70);
    expect(after.damaged).toBe(10);

    const row = await InventoryTransaction.findOne({ transactionType: 'VENDOR_RETURN' });
    expect(row.bucketFrom).toBe('AVAILABLE');
  });

  it('makes a returned serial a dead end', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();
    await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
      .expect(200);
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RETURN_TO_VENDOR', quantity: 1, serialNumbers: ['SN-1'] })
      .expect(200);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    const rtv = await draftRtv({
      reason: 'FAILED_IN_WARRANTY',
      lines: [{ product: String(ctx.server._id), quantity: 1, sourceBucket: 'DAMAGED' }],
    });
    await VendorReturn.updateOne(
      { _id: rtv.id },
      { $set: { 'lines.0.serialNumbers': [serial._id] } },
    );

    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'PENDING_APPROVAL' }).expect(200);
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/status`)
      .set(auth(ctx.tokens.ADMIN)).send({ status: 'APPROVED' }).expect(200);
    await request(app).post(`/api/v1/vendor-returns/${rtv.id}/send`)
      .set(auth(ctx.tokens.ADMIN)).send({}).expect(200);

    const after = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(after.status).toBe('RETURNED_TO_VENDOR');
    expect(after.warehouse).toBeNull();
    // And now it is out of stock, exactly once.
    expect((await bucketsOf()).total).toBe(0);
  });

  it('raises a vendor return straight from a customer return', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();
    await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
      .expect(200);
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RETURN_TO_VENDOR', quantity: 1, serialNumbers: ['SN-1'] })
      .expect(200);

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/vendor-return`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ vendor: String(ctx.vendor._id), reason: 'FAILED_IN_WARRANTY', expectReplacement: true })
      .expect(201);

    expect(res.body.data.lines[0].quantity).toBe(1);
    expect(res.body.data.expectReplacement).toBe(true);
    // Linked both ways so the unit's history reads customer → us → vendor.
    expect(res.body.data.lines[0].customerReturn.returnNumber).toBe(ret.returnNumber);
  });

  it('refuses to raise one when nothing was earmarked for the vendor', async () => {
    const ret = await (async () => {
      await receive(['SN-1']);
      await sellTo(['SN-1']);
      const r = await approvedReturn();
      await request(app).post(`/api/v1/customer-returns/${r.id}/receive`)
        .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
        .send({ lines: [{ lineId: r.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
        .expect(200);
      await request(app).post(`/api/v1/customer-returns/${r.id}/disposition`)
        .set(auth(ctx.tokens.INVENTORY_MANAGER))
        .send({ lineId: r.lines[0].id, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-1'] })
        .expect(200);
      return r;
    })();

    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/vendor-return`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ vendor: String(ctx.vendor._id), reason: 'FAILED_IN_WARRANTY' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOTHING_TO_RETURN');
  });
});

describe('the ledger still reconciles', () => {
  it('reports no drift after a full return and disposition cycle', async () => {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1', 'SN-2']);
    const ret = await approvedReturn({
      lines: [{ product: String(ctx.server._id), requestedQuantity: 2 }],
    });
    await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 2, serialNumbers: ['SN-1', 'SN-2'] }] })
      .expect(200);
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-1'] })
      .expect(200);
    await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ lineId: ret.lines[0].id, disposition: 'SCRAP', quantity: 1, serialNumbers: ['SN-2'] })
      .expect(200);

    const res = await request(app).post('/api/v1/inventory/reconcile')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    // The ledger is the source of truth; Inventory is a projection of it.
    // Returns are the flow most likely to desynchronise the two.
    expect(res.body.data.drift ?? res.body.data.discrepancies ?? []).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('does not let a viewer raise a return', async () => {
    const res = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.VIEWER))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        reason: 'DEFECTIVE',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      });
    expect(res.status).toBe(403);
  });

  it('does not let sales approve its own return', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const draft = await request(app).post('/api/v1/customer-returns')
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({
        customer: String(ctx.customer._id),
        warehouse: String(ctx.hyd._id),
        reason: 'DEFECTIVE',
        lines: [{ product: String(ctx.server._id), requestedQuantity: 1 }],
      }).expect(201);

    const res = await request(app).post(`/api/v1/customer-returns/${draft.body.data.id}/status`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ status: 'APPROVED' });

    expect(res.status).toBe(403);
  });

  it('does not let a warehouse operator decide a disposition', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();
    await request(app).post(`/api/v1/customer-returns/${ret.id}/receive`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lines: [{ lineId: ret.lines[0].id, receivedQuantity: 1, serialNumbers: ['SN-1'] }] })
      .expect(200);

    // Receiving goods and deciding they are sellable again are different jobs.
    const res = await request(app).post(`/api/v1/customer-returns/${ret.id}/disposition`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ lineId: ret.lines[0].id, disposition: 'RESTOCK', quantity: 1, serialNumbers: ['SN-1'] });

    expect(res.status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('hides a return belonging to another company', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const ret = await approvedReturn();
    await CustomerReturn.updateOne({ _id: ret.id }, { tenantId: new mongoose.Types.ObjectId() });

    const res = await request(app).get(`/api/v1/customer-returns/${ret.id}`)
      .set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(404);
  });
});

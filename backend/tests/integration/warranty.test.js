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
import { ServiceRequest } from '../../src/models/ServiceRequest.js';
import { Notification } from '../../src/models/Notification.js';
import { addMonths } from '../../src/utils/dates.js';
import {
  app, resetDatabase, seedTenant, createUser, signIn, auth, retryOnConflict,
} from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

/** Receives serialized units into the Hyderabad warehouse via a posted GRN. */
async function receive(serials) {
  const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
    vendor: String(ctx.vendor._id),
    warehouse: String(ctx.hyd._id),
    lines: [{
      product: String(ctx.server._id),
      receivedQuantity: serials.length,
      acceptedQuantity: serials.length,
      serialNumbers: serials,
    }],
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  await request(app).post(`/api/v1/grn/${created.body.data.id}/post`)
    .set(auth(ctx.tokens.ADMIN)).expect(200);
}

/**
 * Takes units all the way to the customer, which is what produces a warranty.
 * Phase 8 has nothing of its own to create cover with — it reads what dispatch
 * wrote in Phase 6.
 */
async function sellTo(serials, dispatchDate = '2026-09-10') {
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
      dispatchDate,
      lines: [{ product: String(ctx.server._id), quantity: serials.length, serialNumbers: serials }],
    }));
  if (note.status !== 201) throw new Error(JSON.stringify(note.body));
  return note.body.data;
}

const bucketsOf = async () => {
  const row = await Inventory.findOne({ product: ctx.server._id, warehouse: ctx.hyd._id });
  return {
    available: row?.availableQuantity ?? 0,
    reserved: row?.reservedQuantity ?? 0,
    underService: row?.underServiceQuantity ?? 0,
  };
};

const raise = (body, token = ctx.tokens.SALES_DISPATCH) =>
  request(app).post('/api/v1/service-requests').set(auth(token)).send({
    issueDescription: 'Unit will not power on after a site power cut.',
    ...body,
  });

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  const users = {};
  for (const code of ['ADMIN', 'SALES_DISPATCH', 'SERVICE_ENGINEER', 'INVENTORY_MANAGER', 'VIEWER']) {
    users[code] = await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
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

  ctx = { company, roles, tokens, users, category, hyd, vendor, customer, other, server };
});

describe('warranty register', () => {
  it('derives the status from the end date rather than storing it', async () => {
    await receive(['SN-1', 'SN-2', 'SN-3']);
    await sellTo(['SN-1', 'SN-2', 'SN-3']);

    const all = await Warranty.find({}).sort({ warrantyNumber: 1 });
    expect(all).toHaveLength(3);

    // Push one into the past and one to the edge of the 30-day window. Nothing
    // in the system writes a status field; the list must still classify them.
    await Warranty.updateOne({ _id: all[0]._id }, { endDate: addMonths(new Date(), -1) });
    await Warranty.updateOne(
      { _id: all[1]._id },
      { endDate: new Date(Date.now() + 10 * 86_400_000) },
    );

    const res = await request(app).get('/api/v1/warranties')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);

    const byNumber = Object.fromEntries(res.body.data.map((w) => [w.warrantyNumber, w.status]));
    expect(byNumber[all[0].warrantyNumber]).toBe('EXPIRED');
    expect(byNumber[all[1].warrantyNumber]).toBe('EXPIRING_SOON');
    expect(byNumber[all[2].warrantyNumber]).toBe('ACTIVE');

    // And the stored documents still carry no status of their own.
    const stored = await Warranty.findById(all[0]._id).lean();
    expect(stored.status).toBeUndefined();
    expect(stored.state).toBe('ACTIVE');
  });

  it('filters by derived status using date ranges', async () => {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1', 'SN-2']);
    const [first] = await Warranty.find({}).sort({ warrantyNumber: 1 });
    await Warranty.updateOne({ _id: first._id }, { endDate: addMonths(new Date(), -2) });

    const expired = await request(app).get('/api/v1/warranties?status=EXPIRED')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);
    expect(expired.body.data).toHaveLength(1);
    expect(expired.body.data[0].warrantyNumber).toBe(first.warrantyNumber);

    const active = await request(app).get('/api/v1/warranties?status=ACTIVE')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);
    expect(active.body.data).toHaveLength(1);
    expect(active.body.data[0].warrantyNumber).not.toBe(first.warrantyNumber);
  });

  it('refuses to void cover while a ticket is open against it', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const warranty = await Warranty.findOne({});

    await raise({ serialNumber: 'SN-1' }).expect(201);

    const blocked = await request(app).post(`/api/v1/warranties/${warranty._id}/void`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ reason: 'Customer tampered with the chassis seal' });

    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('WARRANTY_HAS_OPEN_TICKETS');
    expect((await Warranty.findById(warranty._id)).state).toBe('ACTIVE');
  });

  it('extends cover from the existing end date, not from today', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1'], '2026-09-10');
    const before = await Warranty.findOne({});
    expect(before.endDate.toISOString().slice(0, 10)).toBe('2029-09-10');

    const res = await request(app).post(`/api/v1/warranties/${before._id}/extend`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ additionalMonths: 12, reason: 'Customer purchased an extended care pack' })
      .expect(200);

    expect(res.body.data.endDate.slice(0, 10)).toBe('2030-09-10');
    expect(res.body.data.durationMonths).toBe(48);
  });

  it('keeps the register inside its own tenant', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const warranty = await Warranty.findOne({});
    await Warranty.updateOne({ _id: warranty._id }, { tenantId: new mongoose.Types.ObjectId() });

    const res = await request(app).get(`/api/v1/warranties/${warranty._id}`)
      .set(auth(ctx.tokens.SALES_DISPATCH));
    expect(res.status).toBe(404);
  });
});

describe('raising a ticket', () => {
  it('finds the customer and live cover from the serial number alone', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    const res = await raise({ serialNumber: 'sn-1' }).expect(201);

    expect(res.body.data.ticketNumber).toMatch(/^SR/);
    expect(res.body.data.status).toBe('OPEN');
    expect(res.body.data.warrantyApplicable).toBe(true);
    expect(String(res.body.data.customer.id ?? res.body.data.customer._id))
      .toBe(String(ctx.customer._id));
  });

  it('freezes the entitlement at raise time', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    const res = await raise({ serialNumber: 'SN-1' }).expect(201);
    expect(res.body.data.warrantyApplicable).toBe(true);

    // The unit now sits in the workshop for months and the cover lapses. The
    // customer reported the fault while covered, so the repair stays covered —
    // deciding this at closing time would bill people for our queue.
    const warranty = await Warranty.findOne({});
    await Warranty.updateOne({ _id: warranty._id }, { endDate: addMonths(new Date(), -1) });

    const after = await request(app).get(`/api/v1/service-requests/${res.body.data.id}`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).expect(200);

    expect(after.body.data.warrantyApplicable).toBe(true);
    expect(after.body.data.warrantyEndDateAtRaise).toBe(warranty.endDate.toISOString());
  });

  it('marks a lapsed warranty as out of cover at raise time', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    await Warranty.updateOne({}, { endDate: addMonths(new Date(), -1) });

    const res = await raise({ serialNumber: 'SN-1' }).expect(201);
    expect(res.body.data.warrantyApplicable).toBe(false);
  });

  it('sets the SLA clock from the priority', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    const res = await raise({ serialNumber: 'SN-1', priority: 'CRITICAL' }).expect(201);
    const ticket = await ServiceRequest.findById(res.body.data.id);
    const hours = (ticket.slaDueDate - ticket.reportedDate) / 3_600_000;
    expect(hours).toBe(4);
  });

  it('re-bases the SLA on the original report when the priority is raised', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const reportedDate = new Date(Date.now() - 2 * 86_400_000);
    const created = await raise({ serialNumber: 'SN-1', reportedDate }).expect(201);

    await request(app).post(`/api/v1/service-requests/${created.body.data.id}/assign`)
      .set(auth(ctx.tokens.SALES_DISPATCH))
      .send({ assignedTo: String(ctx.users.SERVICE_ENGINEER._id), priority: 'CRITICAL' })
      .expect(200);

    const ticket = await ServiceRequest.findById(created.body.data.id);
    // Four hours after the report two days ago — already overdue, which is the
    // truth. A fresh clock would reward slow triage.
    expect((ticket.slaDueDate - ticket.reportedDate) / 3_600_000).toBe(4);
    expect(ticket.slaDueDate.getTime()).toBeLessThan(Date.now());
  });

  it('rejects a ticket for a unit belonging to another customer', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);

    const res = await raise({ serialNumber: 'SN-1', customer: String(ctx.other._id) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERIAL_CUSTOMER_MISMATCH');
  });

  it('rejects an unknown serial number', async () => {
    const res = await raise({ serialNumber: 'SN-NOPE' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERIAL_NOT_FOUND');
  });

  it('requires either a serial or a customer-and-product pair', async () => {
    // 400, not 422: this is caught by the request schema before any domain
    // rule runs. A shape error and a business-rule refusal are different
    // things and the status codes say which one happened.
    const res = await raise({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('the unit in our hands', () => {
  async function openTicket() {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1']);
    const res = await raise({ serialNumber: 'SN-1' }).expect(201);
    return res.body.data.id;
  }

  it('moves the unit into the under-service bucket on receipt', async () => {
    const id = await openTicket();
    expect((await bucketsOf()).underService).toBe(0);

    const res = await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ warehouse: String(ctx.hyd._id), note: 'Arrived by courier' })
      .expect(200);

    expect(res.body.data.status).toBe('UNDER_INSPECTION');

    // It is in our building, so it must be countable — even though it is still
    // the customer's property.
    expect((await bucketsOf()).underService).toBe(1);
    expect((await SerialNumber.findOne({ serialNumber: 'SN-1' })).status).toBe('UNDER_SERVICE');

    const row = await InventoryTransaction.findOne({ transactionType: 'SERVICE_OUT' });
    expect(row.quantityChange).toBe(1);
    expect(row.bucketTo).toBe('UNDER_SERVICE');
  });

  it('will not receive the same unit twice', async () => {
    const id = await openTicket();
    await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ warehouse: String(ctx.hyd._id) }).expect(200);

    const second = await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ warehouse: String(ctx.hyd._id) });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_RECEIVED');
    expect((await bucketsOf()).underService).toBe(1);
  });

  it('takes the unit back out of stock when it is returned repaired', async () => {
    const id = await openTicket();
    await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ warehouse: String(ctx.hyd._id) }).expect(200);

    for (const status of ['UNDER_REPAIR', 'REPAIRED']) {
      await request(app).post(`/api/v1/service-requests/${id}/status`)
        .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status }).expect(200);
    }

    const res = await request(app).post(`/api/v1/service-requests/${id}/return`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ resolution: 'Replaced the failed power supply unit' })
      .expect(200);

    expect(res.body.data.status).toBe('CLOSED');
    expect((await bucketsOf()).underService).toBe(0);

    const serial = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(serial.status).toBe('DISPATCHED');
    expect(serial.condition).toBe('REFURBISHED');
    expect(serial.warehouse).toBeNull();

    // A repair does not extend cover.
    const warranty = await Warranty.findOne({});
    expect(warranty.endDate.toISOString().slice(0, 10)).toBe('2029-09-10');
    expect(warranty.state).toBe('ACTIVE');
  });

  it('refuses to close while we still hold the unit', async () => {
    const id = await openTicket();
    await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ warehouse: String(ctx.hyd._id) }).expect(200);
    for (const status of ['UNDER_REPAIR', 'REPAIRED']) {
      await request(app).post(`/api/v1/service-requests/${id}/status`)
        .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status }).expect(200);
    }

    const res = await request(app).post(`/api/v1/service-requests/${id}/close`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UNIT_STILL_HELD');
    // The bucket is untouched, so nothing is stranded.
    expect((await bucketsOf()).underService).toBe(1);
  });

  it('enforces the transition table', async () => {
    const id = await openTicket();

    // OPEN → REPAIRED skips inspection and repair entirely.
    const res = await request(app).post(`/api/v1/service-requests/${id}/status`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status: 'REPAIRED' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await ServiceRequest.findById(id)).status).toBe('OPEN');
  });

  it('requires a vendor before sending a unit out for repair', async () => {
    const id = await openTicket();
    await request(app).post(`/api/v1/service-requests/${id}/status`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status: 'UNDER_INSPECTION' }).expect(200);

    const res = await request(app).post(`/api/v1/service-requests/${id}/status`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status: 'SENT_TO_VENDOR' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VENDOR_REQUIRED');

    await request(app).post(`/api/v1/service-requests/${id}/status`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ status: 'SENT_TO_VENDOR', vendor: String(ctx.vendor._id), vendorRmaNumber: 'RMA-9911' })
      .expect(200);

    expect((await ServiceRequest.findById(id)).vendorRmaNumber).toBe('RMA-9911');
  });
});

describe('replacement', () => {
  async function readyToReplace() {
    await receive(['SN-1', 'SN-2']);
    await sellTo(['SN-1'], '2026-09-10');
    const created = await raise({ serialNumber: 'SN-1' }).expect(201);
    const id = created.body.data.id;

    await request(app).post(`/api/v1/service-requests/${id}/receive`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ warehouse: String(ctx.hyd._id) }).expect(200);
    await request(app).post(`/api/v1/service-requests/${id}/status`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ status: 'UNDER_REPAIR' }).expect(200);
    return id;
  }

  it('carries the original end date onto the replacement warranty', async () => {
    const id = await readyToReplace();
    const original = await Warranty.findOne({});

    const res = await request(app).post(`/api/v1/service-requests/${id}/replace`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ replacementSerialNumber: 'SN-2', resolution: 'Board failure, unit swapped' })
      .expect(200);

    expect(res.body.data.status).toBe('REPLACED');

    const fresh = await Warranty.findOne({ previousWarranty: original._id });
    expect(fresh).toBeTruthy();

    // The whole point: cover does not restart. A customer who bought 36 months
    // and claims in month 30 gets the remaining 6, not another 36.
    expect(fresh.endDate.toISOString()).toBe(original.endDate.toISOString());
    expect(fresh.endDate.toISOString().slice(0, 10)).toBe('2029-09-10');
    expect(fresh.startDate.getTime()).toBeGreaterThan(original.startDate.getTime());
    expect(fresh.state).toBe('ACTIVE');

    expect((await Warranty.findById(original._id)).state).toBe('CLAIMED_REPLACED');
  });

  it('moves both units and leaves the buckets balanced', async () => {
    const id = await readyToReplace();
    expect(await bucketsOf()).toMatchObject({ available: 1, underService: 1 });

    await request(app).post(`/api/v1/service-requests/${id}/replace`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ replacementSerialNumber: 'SN-2', resolution: 'Board failure, unit swapped' })
      .expect(200);

    // Both units have left our stock: one to the customer, one written off.
    expect(await bucketsOf()).toMatchObject({ available: 0, reserved: 0, underService: 0 });

    const faulty = await SerialNumber.findOne({ serialNumber: 'SN-1' });
    expect(faulty.status).toBe('REPLACED');
    expect(faulty.customer).toBeNull();
    expect(faulty.warehouse).toBeNull();

    const fresh = await SerialNumber.findOne({ serialNumber: 'SN-2' });
    expect(fresh.status).toBe('DISPATCHED');
    expect(String(fresh.customer)).toBe(String(ctx.customer._id));
    expect(String(fresh.currentWarranty)).toBe(
      String((await Warranty.findOne({ serialNumber: fresh._id, state: 'ACTIVE' }))._id),
    );
  });

  it('links the two serials so the asset history reads across the swap', async () => {
    const id = await readyToReplace();
    await request(app).post(`/api/v1/service-requests/${id}/replace`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ replacementSerialNumber: 'SN-2', resolution: 'Board failure, unit swapped' })
      .expect(200);

    const replacement = await SerialNumber.findOne({ serialNumber: 'SN-2' });

    // Looking up the NEW unit's history finds the ticket raised against the old
    // one, which is how a support engineer discovers it is a repeat failure.
    const history = await request(app)
      .get(`/api/v1/service-requests/serial/${replacement._id}`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).expect(200);

    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].id).toBe(id);
  });

  it('refuses a replacement that is not the same product', async () => {
    const id = await readyToReplace();
    const switchGear = await Product.create({
      tenantId: ctx.company._id, name: 'Switch', sku: 'SW-1', productCode: 'P9',
      category: ctx.category._id, productType: 'SERIALIZED', warrantyMonths: 12,
    });
    await SerialNumber.create({
      tenantId: ctx.company._id, serialNumber: 'SW-AAA', product: switchGear._id,
      warehouse: ctx.hyd._id, status: 'AVAILABLE',
    });

    const res = await request(app).post(`/api/v1/service-requests/${id}/replace`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ replacementSerialNumber: 'SW-AAA', resolution: 'Swap attempt' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PRODUCT_MISMATCH');
    expect((await bucketsOf()).underService).toBe(1);
  });

  it('refuses a replacement unit that is not available', async () => {
    const id = await readyToReplace();
    await SerialNumber.updateOne({ serialNumber: 'SN-2' }, { status: 'DAMAGED' });

    const res = await request(app).post(`/api/v1/service-requests/${id}/replace`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER))
      .send({ replacementSerialNumber: 'SN-2', resolution: 'Swap attempt' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REPLACEMENT_NOT_AVAILABLE');
    // Nothing partially applied: the faulty unit is still held.
    expect((await ServiceRequest.findById(id)).status).toBe('UNDER_REPAIR');
    expect((await bucketsOf()).underService).toBe(1);
  });
});

describe('permissions', () => {
  it('does not let a viewer raise a ticket', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const res = await raise({ serialNumber: 'SN-1' }, ctx.tokens.VIEWER);
    expect(res.status).toBe(403);
  });

  it('does not let sales work a ticket', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const created = await raise({ serialNumber: 'SN-1' }).expect(201);

    const res = await request(app).post(`/api/v1/service-requests/${created.body.data.id}/receive`)
      .set(auth(ctx.tokens.SALES_DISPATCH)).send({ warehouse: String(ctx.hyd._id) });
    expect(res.status).toBe(403);
  });

  it('does not let an engineer void a warranty', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const warranty = await Warranty.findOne({});

    const res = await request(app).post(`/api/v1/warranties/${warranty._id}/void`)
      .set(auth(ctx.tokens.SERVICE_ENGINEER)).send({ reason: 'Seal was tampered with' });
    expect(res.status).toBe(403);
  });
});

describe('notifications', () => {
  it('notifies the people who can assign when a ticket is raised', async () => {
    await receive(['SN-1']);
    await sellTo(['SN-1']);
    const created = await raise({ serialNumber: 'SN-1', priority: 'CRITICAL' }).expect(201);

    const notes = await Notification.find({ type: 'SERVICE_REQUEST_RAISED' });
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe('WARNING');
    expect(notes[0].dedupeKey).toBe(`SERVICE_RAISED:${created.body.data.id}`);
  });
});

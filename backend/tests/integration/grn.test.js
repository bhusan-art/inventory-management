import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Inventory } from '../../src/models/Inventory.js';
import { InventoryTransaction } from '../../src/models/InventoryTransaction.js';
import { SerialNumber, SerialNumberEvent } from '../../src/models/SerialNumber.js';
import { PurchaseOrder } from '../../src/models/PurchaseOrder.js';
import { GRN } from '../../src/models/GRN.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'INVENTORY_MANAGER', 'WAREHOUSE_OPERATOR', 'SALES_DISPATCH', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const vendor = await Vendor.create({ tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL' });
  const warehouse = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const otherWarehouse = await Warehouse.create({ tenantId: company._id, name: 'Bengaluru', code: 'WH-BLR' });

  const serialized = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'PC-1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36,
  });
  const bulk = await Product.create({
    tenantId: company._id, name: 'Fibre Cable', sku: 'OFC-1', productCode: 'PC-2',
    category: category._id, productType: 'NON_SERIALIZED', unitOfMeasure: 'MTR',
  });

  ctx = { company, roles, tokens, category, vendor, warehouse, otherWarehouse, serialized, bulk };
});

const grnBody = (over = {}) => ({
  vendor: String(ctx.vendor._id),
  warehouse: String(ctx.warehouse._id),
  lines: [{
    product: String(ctx.bulk._id),
    receivedQuantity: 100, acceptedQuantity: 100,
  }],
  ...over,
});

async function createAndPost(body, token = ctx.tokens.ADMIN) {
  const created = await request(app).post('/api/v1/grn').set(auth(token)).send(body);
  if (created.status !== 201) return created;
  return request(app).post(`/api/v1/grn/${created.body.data.id}/post`).set(auth(token));
}

describe('GRN posting — the ledger', () => {
  it('moves stock and writes a matching ledger row', async () => {
    const res = await createAndPost(grnBody());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('POSTED');

    const stock = await Inventory.findOne({ product: ctx.bulk._id, warehouse: ctx.warehouse._id });
    expect(stock.availableQuantity).toBe(100);

    const ledger = await InventoryTransaction.find({ product: ctx.bulk._id });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      transactionType: 'PURCHASE_RECEIVED',
      direction: 'IN',
      quantityBefore: 0,
      quantityChange: 100,
      quantityAfter: 100,
      bucketTo: 'AVAILABLE',
    });
  });

  it('keeps quantityBefore + change = quantityAfter across successive receipts', async () => {
    await createAndPost(grnBody({ vendorInvoiceNumber: 'INV-1' }));
    await createAndPost(grnBody({
      vendorInvoiceNumber: 'INV-2',
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 40, acceptedQuantity: 40 }],
    }));

    const ledger = await InventoryTransaction.find({ product: ctx.bulk._id }).sort({ createdAt: 1 });
    expect(ledger).toHaveLength(2);
    for (const row of ledger) {
      expect(row.quantityBefore + row.quantityChange).toBe(row.quantityAfter);
    }
    expect(ledger[1].quantityBefore).toBe(100);
    expect(ledger[1].quantityAfter).toBe(140);
  });

  it('separates damaged stock from available', async () => {
    await createAndPost(grnBody({
      lines: [{
        product: String(ctx.bulk._id),
        receivedQuantity: 100, acceptedQuantity: 80, damagedQuantity: 20,
      }],
    }));

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(80);
    expect(stock.damagedQuantity).toBe(20);

    // Both movements are visible in the ledger, distinguished by bucket.
    const rows = await InventoryTransaction.find({ product: ctx.bulk._id });
    expect(rows.map((r) => r.bucketTo).sort()).toEqual(['AVAILABLE', 'DAMAGED']);
  });

  it('adds nothing for rejected or short quantities', async () => {
    await createAndPost(grnBody({
      lines: [{
        product: String(ctx.bulk._id),
        receivedQuantity: 100, acceptedQuantity: 90, rejectedQuantity: 10, shortQuantity: 5,
      }],
    }));

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    // Rejected goods are physically present but refused; short goods never
    // arrived. Neither is stock.
    expect(stock.availableQuantity).toBe(90);
    expect(stock.damagedQuantity).toBe(0);
  });

  it('refuses to post the same GRN twice', async () => {
    const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody());
    const id = created.body.data.id;

    await request(app).post(`/api/v1/grn/${id}/post`).set(auth(ctx.tokens.ADMIN)).expect(200);
    const second = await request(app).post(`/api/v1/grn/${id}/post`).set(auth(ctx.tokens.ADMIN));

    expect(second.status).toBe(409);
    expect(second.body.errors?.[0]?.code ?? second.body.message).toBeTruthy();

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(100); // not 200
  });

  it('leaves a draft GRN invisible to stock', async () => {
    await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody());
    expect(await Inventory.countDocuments({})).toBe(0);
    expect(await InventoryTransaction.countDocuments({})).toBe(0);
  });
});

describe('GRN posting — atomicity (phase exit criterion)', () => {
  it('leaves zero partial state when a later line fails', async () => {
    // Line 1 is a clean bulk receipt. Line 2 is serialized and will fail
    // because one of its serials already exists. Line 1's stock movement,
    // ledger row and the PO tally must all be rolled back.
    await SerialNumber.create({
      tenantId: ctx.company._id, serialNumber: 'SN-EXISTING',
      product: ctx.serialized._id, status: 'AVAILABLE', warehouse: ctx.warehouse._id,
    });

    const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      lines: [
        { product: String(ctx.bulk._id), receivedQuantity: 100, acceptedQuantity: 100 },
        {
          product: String(ctx.serialized._id), receivedQuantity: 2, acceptedQuantity: 2,
          serialNumbers: ['SN-NEW-1', 'SN-EXISTING'],
        },
      ],
    }));
    expect(created.status).toBe(201);

    const posted = await request(app)
      .post(`/api/v1/grn/${created.body.data.id}/post`)
      .set(auth(ctx.tokens.ADMIN));

    expect(posted.status).toBe(409);

    // Nothing survived: not the bulk stock, not its ledger row, not the
    // serial that would have been created before the failure.
    expect(await Inventory.countDocuments({})).toBe(0);
    expect(await InventoryTransaction.countDocuments({})).toBe(0);
    expect(await SerialNumber.countDocuments({ serialNumber: 'SN-NEW-1' })).toBe(0);
    expect(await SerialNumberEvent.countDocuments({})).toBe(0);

    const grn = await GRN.findById(created.body.data.id);
    expect(grn.status).toBe('DRAFT'); // still postable once corrected
  });

  it('rolls back the purchase order tally too', async () => {
    const po = await PurchaseOrder.create({
      tenantId: ctx.company._id, poNumber: 'PO/T/1', vendor: ctx.vendor._id,
      warehouse: ctx.warehouse._id, status: 'APPROVED',
      lines: [
        { product: ctx.bulk._id, orderedQuantity: 100 },
        { product: ctx.serialized._id, orderedQuantity: 2 },
      ],
    });

    await SerialNumber.create({
      tenantId: ctx.company._id, serialNumber: 'SN-TAKEN',
      product: ctx.serialized._id, status: 'AVAILABLE',
    });

    const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      purchaseOrder: String(po._id),
      lines: [
        { product: String(ctx.bulk._id), receivedQuantity: 100, acceptedQuantity: 100 },
        {
          product: String(ctx.serialized._id), receivedQuantity: 1, acceptedQuantity: 1,
          serialNumbers: ['SN-TAKEN'],
        },
      ],
    }));

    await request(app).post(`/api/v1/grn/${created.body.data.id}/post`).set(auth(ctx.tokens.ADMIN));

    const after = await PurchaseOrder.findById(po._id);
    expect(after.lines[0].receivedQuantity).toBe(0);
    expect(after.status).toBe('APPROVED');
  });
});

describe('serialized receipts', () => {
  it('creates one serial per accepted unit, available for issue', async () => {
    await createAndPost(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 3, acceptedQuantity: 3,
        serialNumbers: ['SN-001', 'SN-002', 'SN-003'],
      }],
    }));

    const serials = await SerialNumber.find({ product: ctx.serialized._id }).sort({ serialNumber: 1 });
    expect(serials).toHaveLength(3);
    expect(serials.every((s) => s.status === 'AVAILABLE')).toBe(true);
    expect(serials[0].warehouse).toBeTruthy();

    // Two events each: created as RECEIVED, then QC-passed to AVAILABLE.
    expect(await SerialNumberEvent.countDocuments({})).toBe(6);

    const stock = await Inventory.findOne({ product: ctx.serialized._id });
    expect(stock.availableQuantity).toBe(3);
  });

  it('rejects a serial count that does not match the accepted quantity', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 3, acceptedQuantity: 3,
        serialNumbers: ['SN-001', 'SN-002'],
      }],
    }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('SERIAL_COUNT_MISMATCH');
  });

  it('reports every duplicate at once, not one at a time', async () => {
    await SerialNumber.create([
      { tenantId: ctx.company._id, serialNumber: 'SN-A', product: ctx.serialized._id, status: 'AVAILABLE' },
      { tenantId: ctx.company._id, serialNumber: 'SN-B', product: ctx.serialized._id, status: 'AVAILABLE' },
    ]);

    const res = await createAndPost(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 3, acceptedQuantity: 3,
        serialNumbers: ['SN-A', 'SN-B', 'SN-C'],
      }],
    }));

    expect(res.status).toBe(409);
    // Receiving a pallet with three duplicates should surface all three, not
    // make the operator retry once per duplicate.
    expect(res.body.errors.map((e) => e.serialNumber).sort()).toEqual(['SN-A', 'SN-B']);
  });

  it('catches a serial repeated within the same receipt', async () => {
    const res = await createAndPost(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 2, acceptedQuantity: 2,
        serialNumbers: ['SN-X', 'SN-X'],
      }],
    }));
    expect(res.status).toBe(409);
  });

  it('enforces the product serial format when one is set', async () => {
    await Product.updateOne({ _id: ctx.serialized._id }, { serialFormatPattern: '^SRV[0-9]{4}$' });

    const bad = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 1, acceptedQuantity: 1,
        serialNumbers: ['WRONG-1'],
      }],
    }));
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].code).toBe('SERIAL_FORMAT_INVALID');

    const good = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 1, acceptedQuantity: 1,
        serialNumbers: ['SRV0001'],
      }],
    }));
    expect(good.status).toBe(201);
  });

  it('refuses serial numbers on a non-serialized product', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      lines: [{
        product: String(ctx.bulk._id), receivedQuantity: 1, acceptedQuantity: 1,
        serialNumbers: ['SN-1'],
      }],
    }));
    expect(res.status).toBe(422);
  });
});

describe('partial receiving against a purchase order', () => {
  let po;

  beforeEach(async () => {
    po = await PurchaseOrder.create({
      tenantId: ctx.company._id, poNumber: 'PO/T/100', vendor: ctx.vendor._id,
      warehouse: ctx.warehouse._id, status: 'APPROVED',
      lines: [{ product: ctx.bulk._id, orderedQuantity: 100 }],
    });
  });

  it('marks the order partially received and tracks the balance', async () => {
    await createAndPost(grnBody({
      purchaseOrder: String(po._id), vendorInvoiceNumber: 'INV-P1',
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 80, acceptedQuantity: 80 }],
    }));

    const after = await PurchaseOrder.findById(po._id);
    expect(after.status).toBe('PARTIALLY_RECEIVED');
    expect(after.lines[0].receivedQuantity).toBe(80);

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(80); // not 100
  });

  it('completes the order on the second receipt', async () => {
    await createAndPost(grnBody({
      purchaseOrder: String(po._id), vendorInvoiceNumber: 'INV-P1',
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 80, acceptedQuantity: 80 }],
    }));
    await createAndPost(grnBody({
      purchaseOrder: String(po._id), vendorInvoiceNumber: 'INV-P2',
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 20, acceptedQuantity: 20 }],
    }));

    const after = await PurchaseOrder.findById(po._id);
    expect(after.status).toBe('RECEIVED');

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(100);
  });

  it('refuses to receive more than the outstanding balance', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      purchaseOrder: String(po._id),
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 150, acceptedQuantity: 150 }],
    }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('OVER_RECEIPT_EXCEEDED');
  });

  it('refuses a product that is not on the order', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send(grnBody({
      purchaseOrder: String(po._id),
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 1, acceptedQuantity: 1,
        serialNumbers: ['SN-9'],
      }],
    }));
    expect(res.status).toBe(422);
  });
});

describe('duplicate vendor invoices', () => {
  it('refuses the same invoice number from the same vendor twice', async () => {
    await createAndPost(grnBody({ vendorInvoiceNumber: 'INV-777' }));

    const second = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN))
      .send(grnBody({ vendorInvoiceNumber: 'INV-777' }));

    // Without amounts in the system, this is the control that catches the same
    // delivery being entered twice.
    expect(second.status).toBe(409);
    expect(second.body.errors?.[0]?.code ?? second.body.message).toBeTruthy();
  });

  it('allows the same invoice number from a different vendor', async () => {
    const other = await Vendor.create({ tenantId: ctx.company._id, vendorName: 'HP', vendorCode: 'V-HP' });
    await createAndPost(grnBody({ vendorInvoiceNumber: 'INV-777' }));

    const res = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN))
      .send(grnBody({ vendor: String(other._id), vendorInvoiceNumber: 'INV-777' }));
    expect(res.status).toBe(201);
  });
});

describe('GRN cancellation', () => {
  it('reverses stock with compensating entries rather than deleting history', async () => {
    const posted = await createAndPost(grnBody());
    const id = posted.body.data.id;

    const res = await request(app).post(`/api/v1/grn/${id}/cancel`)
      .set(auth(ctx.tokens.ADMIN)).send({ reason: 'Entered against the wrong vendor' });

    expect(res.status).toBe(200);

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(0);

    // The original row is still there. The ledger records what happened,
    // including mistakes.
    const rows = await InventoryTransaction.find({ product: ctx.bulk._id }).sort({ createdAt: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0].quantityChange).toBe(100);
    expect(rows[1].quantityChange).toBe(-100);
  });

  it('refuses when units from the receipt have already moved on', async () => {
    const posted = await createAndPost(grnBody({
      lines: [{
        product: String(ctx.serialized._id), receivedQuantity: 1, acceptedQuantity: 1,
        serialNumbers: ['SN-MOVED'],
      }],
    }));

    await SerialNumber.updateOne({ serialNumber: 'SN-MOVED' }, { status: 'RESERVED' });

    const res = await request(app).post(`/api/v1/grn/${posted.body.data.id}/cancel`)
      .set(auth(ctx.tokens.ADMIN)).send({ reason: 'Mistake' });

    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('is denied to a warehouse operator, who may post but not reverse', async () => {
    const posted = await createAndPost(grnBody());
    const res = await request(app).post(`/api/v1/grn/${posted.body.data.id}/cancel`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR)).send({ reason: 'Mistake' });
    expect(res.status).toBe(403);
  });
});

describe('the ledger is append-only', () => {
  it('refuses updates and deletes at the model level', async () => {
    await createAndPost(grnBody());
    const row = await InventoryTransaction.findOne({});

    await expect(InventoryTransaction.updateOne({ _id: row._id }, { quantityChange: 5 }))
      .rejects.toThrow(/append-only/);
    await expect(InventoryTransaction.deleteOne({ _id: row._id })).rejects.toThrow(/append-only/);
    await expect(InventoryTransaction.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('warehouse scope', () => {
  it('hides GRNs from warehouses the operator is not assigned to', async () => {
    await createAndPost(grnBody());

    await createUser({
      company: ctx.company, role: ctx.roles.WAREHOUSE_OPERATOR, email: 'scoped@test.local',
      overrides: { scope: { warehouseIds: [ctx.otherWarehouse._id] } },
    });
    const token = (await signIn('scoped@test.local')).accessToken;

    const list = await request(app).get('/api/v1/grn').set(auth(token));
    expect(list.body.data).toHaveLength(0);

    const grn = await GRN.findOne({});
    const direct = await request(app).get(`/api/v1/grn/${grn._id}`).set(auth(token));
    // 404 rather than 403 — confirming the record exists is a disclosure.
    expect(direct.status).toBe(404);
  });

  it('refuses receiving into a warehouse outside the operator’s scope', async () => {
    await createUser({
      company: ctx.company, role: ctx.roles.WAREHOUSE_OPERATOR, email: 'scoped2@test.local',
      overrides: { scope: { warehouseIds: [ctx.otherWarehouse._id] } },
    });
    const token = (await signIn('scoped2@test.local')).accessToken;

    const res = await request(app).post('/api/v1/grn').set(auth(token)).send(grnBody());
    expect(res.status).toBe(404);
  });
});

describe('insufficient stock guard', () => {
  it('refuses a decrement larger than the balance, atomically', async () => {
    await createAndPost(grnBody({
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 10, acceptedQuantity: 10 }],
    }));

    const { withTransaction } = await import('../../src/services/shared/transaction.js');
    const { applyMovement } = await import('../../src/services/inventory/ledgerService.js');
    const actor = { id: new mongoose.Types.ObjectId(), tenantId: ctx.company._id };

    await expect(withTransaction(({ session }) => applyMovement({
      session, actor,
      product: ctx.bulk._id, warehouse: ctx.warehouse._id,
      bucket: 'AVAILABLE', quantityChange: -25,
      transactionType: 'DISPATCH', referenceType: 'DISPATCH_NOTE',
    }))).rejects.toThrow(/Insufficient/);

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(10);
    expect(await InventoryTransaction.countDocuments({})).toBe(1);
  });

  it('lets exactly one of two concurrent claims on the last units succeed', async () => {
    await createAndPost(grnBody({
      lines: [{ product: String(ctx.bulk._id), receivedQuantity: 10, acceptedQuantity: 10 }],
    }));

    const { withTransaction } = await import('../../src/services/shared/transaction.js');
    const { applyMovement } = await import('../../src/services/inventory/ledgerService.js');
    const actor = { id: new mongoose.Types.ObjectId(), tenantId: ctx.company._id };

    const claim = () => withTransaction(({ session }) => applyMovement({
      session, actor,
      product: ctx.bulk._id, warehouse: ctx.warehouse._id,
      bucket: 'AVAILABLE', quantityChange: -10,
      transactionType: 'DISPATCH', referenceType: 'DISPATCH_NOTE',
    }));

    const results = await Promise.allSettled([claim(), claim()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // The guarded update is what makes this one, not two. A read-check-write
    // in application code would let both through.
    expect(fulfilled).toHaveLength(1);

    const stock = await Inventory.findOne({ product: ctx.bulk._id });
    expect(stock.availableQuantity).toBe(0);
  });
});

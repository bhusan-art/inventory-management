import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Inventory } from '../../src/models/Inventory.js';
import { SerialNumber, SerialNumberEvent } from '../../src/models/SerialNumber.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { auditSerialConsistency } from '../../src/services/serial/serialQueryService.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

async function receive(serials) {
  const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
    vendor: String(ctx.vendorId),
    warehouse: String(ctx.hyd._id),
    lines: [{
      product: String(ctx.server._id),
      receivedQuantity: serials.length,
      acceptedQuantity: serials.length,
      serialNumbers: serials,
    }],
  });
  await request(app).post(`/api/v1/grn/${created.body.data.id}/post`).set(auth(ctx.tokens.ADMIN)).expect(200);
}

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'INVENTORY_MANAGER', 'WAREHOUSE_OPERATOR', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const { Vendor } = await import('../../src/models/Vendor.js');
  const vendor = await Vendor.create({ tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL' });
  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });

  const server = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'P1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36,
  });

  ctx = { company, roles, tokens, hyd, server, vendorId: vendor._id, category };
});

describe('the scan endpoint', () => {
  beforeEach(async () => { await receive(['SN-001', 'SN-002']); });

  it('returns everything about a unit in one call', async () => {
    const res = await request(app).get('/api/v1/serials/scan/SN-001').set(auth(ctx.tokens.WAREHOUSE_OPERATOR));

    expect(res.status).toBe(200);
    expect(res.body.data.serialNumber).toBe('SN-001');
    expect(res.body.data.product.name).toBe('Rack Server');
    expect(res.body.data.warehouse.name).toBe('Hyderabad');
    expect(res.body.data.status).toBe('AVAILABLE');
    expect(res.body.data.countsAsStock).toBe(true);
    // Two events already: created as RECEIVED, QC-passed to AVAILABLE.
    expect(res.body.data.recentEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('tells the caller which moves are legal next', async () => {
    const res = await request(app).get('/api/v1/serials/scan/SN-001').set(auth(ctx.tokens.ADMIN));
    // So the UI offers only valid actions instead of buttons that get refused.
    expect(res.body.data.allowedTransitions).toContain('RESERVED');
    expect(res.body.data.allowedTransitions).not.toContain('DISPATCHED');
  });

  it('is case-insensitive, because nobody types a serial in caps', async () => {
    const res = await request(app).get('/api/v1/serials/scan/sn-001').set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
  });

  it('404s an unknown serial with a useful message', async () => {
    const res = await request(app).get('/api/v1/serials/scan/NOPE-999').set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/NOPE-999/);
  });

  it('is not shadowed by the /:id route', async () => {
    // /scan/:serialNumber is mounted first so a serial is never parsed as an id.
    const res = await request(app).get('/api/v1/serials/scan/SN-002').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data.serialNumber).toBe('SN-002');
  });
});

describe('per-unit history', () => {
  it('shows the full lifecycle plus the stock movements behind it', async () => {
    await receive(['SN-100']);
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-100' });

    const res = await request(app).get(`/api/v1/serials/${serial._id}/history`).set(auth(ctx.tokens.ADMIN));

    expect(res.status).toBe(200);
    const statuses = res.body.data.events.map((e) => e.toStatus);
    expect(statuses).toEqual(expect.arrayContaining(['RECEIVED', 'AVAILABLE']));
    expect(res.body.data.movements.length).toBeGreaterThanOrEqual(0);
    expect(res.body.data.events[0].performedBy).toBeTruthy();
  });
});

describe('status override keeps quantities in step', () => {
  beforeEach(async () => { await receive(['SN-200', 'SN-201', 'SN-202']); });

  const overrideTo = (id, body) => request(app).patch(`/api/v1/serials/${id}/status`)
    .set(auth(ctx.tokens.ADMIN)).send(body);

  it('moves the unit between buckets when the status changes', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-200' });

    const before = await Inventory.findOne({ product: ctx.server._id, warehouse: ctx.hyd._id });
    expect(before.availableQuantity).toBe(3);
    expect(before.damagedQuantity).toBe(0);

    const res = await overrideTo(serial._id, {
      toStatus: 'DAMAGED', reasonCode: 'DAMAGE',
      remarks: 'Dropped during put-away, chassis bent',
    });
    expect(res.status).toBe(200);

    // The whole point: the quantity followed the status. Changing one without
    // the other would be self-inflicted drift.
    const after = await Inventory.findOne({ product: ctx.server._id, warehouse: ctx.hyd._id });
    expect(after.availableQuantity).toBe(2);
    expect(after.damagedQuantity).toBe(1);
    expect(after.availableQuantity + after.damagedQuantity).toBe(3);
  });

  it('removes the unit from stock when it moves to a terminal status', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-201' });

    await overrideTo(serial._id, {
      toStatus: 'SCRAPPED', reasonCode: 'DAMAGE',
      remarks: 'Beyond economical repair, disposed of',
    }).expect(200);

    const after = await Inventory.findOne({ product: ctx.server._id, warehouse: ctx.hyd._id });
    expect(after.availableQuantity).toBe(2);
    // Scrapped units are gone, not sitting in another bucket.
    expect(after.damagedQuantity).toBe(0);
  });

  it('leaves serial records and quantities in agreement after several overrides', async () => {
    const serials = await SerialNumber.find({ product: ctx.server._id }).sort({ serialNumber: 1 });

    await overrideTo(serials[0]._id, { toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Bent chassis on arrival' });
    await overrideTo(serials[1]._id, { toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Water ingress in rack two' });
    await overrideTo(serials[1]._id, { toStatus: 'AVAILABLE', reasonCode: 'DATA_CORRECTION', remarks: 'Inspected and found serviceable' });

    const audit = await auditSerialConsistency(ctx.company._id, ctx.server._id);
    expect(audit.mismatches).toEqual([]);
  });

  it('rejects a move the transition table forbids', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-202' });
    const res = await overrideTo(serial._id, {
      toStatus: 'DISPATCHED', reasonCode: 'DATA_CORRECTION',
      remarks: 'Trying to skip the reservation step',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('INVALID_STATE_TRANSITION');
  });

  it('demands a written explanation', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-202' });
    const res = await overrideTo(serial._id, { toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'broke' });
    expect(res.status).toBe(400);
  });

  it('records the override as CRITICAL', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-202' });
    await overrideTo(serial._id, {
      toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Packaging crushed in transit',
    });

    const entry = await AuditLog.findOne({ action: 'SERIAL_STATUS_OVERRIDDEN' });
    expect(entry.severity).toBe('CRITICAL');
    expect(entry.changes[0]).toMatchObject({ before: 'AVAILABLE', after: 'DAMAGED' });
  });

  it('is denied to roles without OVERRIDE_SERIAL_STATUS', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-202' });
    const res = await request(app).patch(`/api/v1/serials/${serial._id}/status`)
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR))
      .send({ toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Found damaged on the shelf' });
    expect(res.status).toBe(403);
  });

  it('writes a history event for the override', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-202' });
    await overrideTo(serial._id, {
      toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Cracked casing noticed at audit',
    });

    const event = await SerialNumberEvent.findOne({ eventType: 'MANUAL_OVERRIDE' });
    expect(event).toMatchObject({ fromStatus: 'AVAILABLE', toStatus: 'DAMAGED' });
  });
});

describe('identifiers', () => {
  beforeEach(async () => { await receive(['SN-300', 'SN-301']); });

  it('records an asset tag and MAC address', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-300' });
    const res = await request(app).patch(`/api/v1/serials/${serial._id}`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ assetTag: 'IT-ASSET-0042', macAddress: 'AA:BB:CC:DD:EE:FF' });

    expect(res.status).toBe(200);
    expect(res.body.data.assetTag).toBe('IT-ASSET-0042');
  });

  it('refuses an asset tag already used by another unit', async () => {
    const [a, b] = await SerialNumber.find({ product: ctx.server._id }).sort({ serialNumber: 1 });

    await request(app).patch(`/api/v1/serials/${a._id}`).set(auth(ctx.tokens.ADMIN))
      .send({ assetTag: 'IT-ASSET-0042' }).expect(200);

    const res = await request(app).patch(`/api/v1/serials/${b._id}`).set(auth(ctx.tokens.ADMIN))
      .send({ assetTag: 'IT-ASSET-0042' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/SN-300/);
  });

  it('rejects a malformed MAC address', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-300' });
    const res = await request(app).patch(`/api/v1/serials/${serial._id}`)
      .set(auth(ctx.tokens.ADMIN)).send({ macAddress: 'not-a-mac' });
    expect(res.status).toBe(400);
  });

  it('finds a unit by asset tag', async () => {
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-300' });
    await request(app).patch(`/api/v1/serials/${serial._id}`).set(auth(ctx.tokens.ADMIN))
      .send({ assetTag: 'IT-ASSET-0042' });

    const res = await request(app).get('/api/v1/serials?search=IT-ASSET-0042').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].serialNumber).toBe('SN-300');
  });
});

describe('labels', () => {
  it('serves a QR SVG containing only the serial number', async () => {
    await receive(['SN-400']);
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-400' });

    const res = await request(app).get(`/api/v1/serials/${serial._id}/qrcode`).set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    // The rendered SVG is paths, but assert no leakage regardless.
    expect(res.text).not.toMatch(/Rack Server|WH-HYD|Dell/);
  });

  it('renders a printable label sheet sized in millimetres', async () => {
    await receive(['SN-401']);
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-401' });

    const res = await request(app).get(`/api/v1/serials/${serial._id}/label`).set(auth(ctx.tokens.ADMIN));
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('50mm 25mm');
    expect(res.text).toContain('SRV-1');
  });
});

describe('opening-balance import', () => {
  const header = 'serialNumber,sku,assetTag\n';

  it('reports what would happen without writing anything', async () => {
    const csv = `${header}LEGACY-1,SRV-1,TAG-1\nLEGACY-2,SRV-1,TAG-2\n`;

    const res = await request(app).post('/api/v1/serials/import').set(auth(ctx.tokens.ADMIN))
      .send({ csv, warehouse: String(ctx.hyd._id), dryRun: true });

    expect(res.body.data.valid).toBe(2);
    expect(res.body.data.imported).toBe(0);
    expect(await SerialNumber.countDocuments({})).toBe(0);
  });

  it('creates both the serial records and the matching stock', async () => {
    const csv = `${header}LEGACY-1,SRV-1,TAG-1\nLEGACY-2,SRV-1,TAG-2\nLEGACY-3,SRV-1,\n`;

    const res = await request(app).post('/api/v1/serials/import').set(auth(ctx.tokens.ADMIN))
      .send({ csv, warehouse: String(ctx.hyd._id), dryRun: false });

    expect(res.body.data.imported).toBe(3);
    expect(await SerialNumber.countDocuments({ status: 'AVAILABLE' })).toBe(3);

    // Serial records without matching quantity would be drift on day one.
    const stock = await Inventory.findOne({ product: ctx.server._id, warehouse: ctx.hyd._id });
    expect(stock.availableQuantity).toBe(3);

    const audit = await auditSerialConsistency(ctx.company._id, ctx.server._id);
    expect(audit.mismatches).toEqual([]);
  });

  it('imports all rows or none', async () => {
    const csv = `${header}LEGACY-1,SRV-1,TAG-1\nLEGACY-2,NO-SUCH-SKU,TAG-2\n`;

    const res = await request(app).post('/api/v1/serials/import').set(auth(ctx.tokens.ADMIN))
      .send({ csv, warehouse: String(ctx.hyd._id), dryRun: false });

    expect(res.body.data.imported).toBe(0);
    expect(await SerialNumber.countDocuments({})).toBe(0);
  });

  it('rejects a serial that already exists', async () => {
    await receive(['SN-500']);
    const csv = `${header}SN-500,SRV-1,TAG-9\n`;

    const res = await request(app).post('/api/v1/serials/import').set(auth(ctx.tokens.ADMIN))
      .send({ csv, warehouse: String(ctx.hyd._id), dryRun: false });

    expect(res.body.data.invalid).toBe(1);
    expect(res.body.data.errors[0].issues.join(' ')).toMatch(/already exists/);
  });

  it('is denied without the elevated permission', async () => {
    const csv = `${header}LEGACY-9,SRV-1,\n`;
    // It creates stock from nothing, so it needs the same ceiling as a large
    // adjustment.
    const res = await request(app).post('/api/v1/serials/import').set(auth(ctx.tokens.INVENTORY_MANAGER))
      .send({ csv, warehouse: String(ctx.hyd._id), dryRun: true });
    expect(res.status).toBe(403);
  });
});

describe('serial listing', () => {
  it('filters by status', async () => {
    await receive(['SN-600', 'SN-601']);
    const serial = await SerialNumber.findOne({ serialNumber: 'SN-600' });
    await request(app).patch(`/api/v1/serials/${serial._id}/status`).set(auth(ctx.tokens.ADMIN))
      .send({ toStatus: 'DAMAGED', reasonCode: 'DAMAGE', remarks: 'Damaged during unloading' });

    const res = await request(app).get('/api/v1/serials?status=DAMAGED').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].serialNumber).toBe('SN-600');
  });

  it('escapes regex metacharacters in search', async () => {
    await receive(['SN-700']);
    const res = await request(app).get('/api/v1/serials?search=.*').set(auth(ctx.tokens.ADMIN));
    expect(res.body.data).toHaveLength(0);
  });
});

import mongoose from 'mongoose';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Customer } from '../../src/models/Customer.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Notification } from '../../src/models/Notification.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

async function receive(serials) {
  const created = await request(app).post('/api/v1/grn').set(auth(ctx.tokens.ADMIN)).send({
    vendor: String(ctx.vendor._id),
    warehouse: String(ctx.hyd._id),
    lines: [{
      product: String(ctx.server._id),
      receivedQuantity: serials.length + 2,
      acceptedQuantity: serials.length,
      damagedQuantity: 2,
      serialNumbers: serials,
    }],
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  await request(app).post(`/api/v1/grn/${created.body.data.id}/post`)
    .set(auth(ctx.tokens.ADMIN)).expect(200);
}

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  const users = {};
  for (const code of ['SUPER_ADMIN', 'ADMIN', 'INVENTORY_MANAGER', 'SALES_DISPATCH', 'WAREHOUSE_OPERATOR', 'VIEWER']) {
    users[code] = await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const vendor = await Vendor.create({
    tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL', phone: '+919812345678',
  });
  const customer = await Customer.create({
    tenantId: company._id, customerName: 'ACME Technologies', customerCode: 'C-ACME',
    phone: '+919876543210', email: 'ops@acme.test',
  });
  const server = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'P1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36, reorderLevel: 10,
  });

  ctx = { company, roles, tokens, users, category, hyd, vendor, customer, server };
});

describe('the report menu', () => {
  it('offers only reports the actor can actually run', async () => {
    const admin = await request(app).get('/api/v1/reports')
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);
    expect(admin.body.data.length).toBeGreaterThanOrEqual(7);

    const sales = await request(app).get('/api/v1/reports')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);

    const keys = sales.body.data.map((r) => r.key);
    // Sales holds no VIEW_VENDOR, so the menu must not advertise it.
    expect(keys).not.toContain('vendor-performance');
    expect(keys).toContain('customer-assets');
  });

  it('refuses a report the actor lacks the permission for', async () => {
    const res = await request(app).get('/api/v1/reports/vendor-performance')
      .set(auth(ctx.tokens.SALES_DISPATCH));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REPORT_ACCESS_DENIED');
  });

  it('rejects an unknown report key at the schema', async () => {
    const res = await request(app).get('/api/v1/reports/not-a-report')
      .set(auth(ctx.tokens.SUPER_ADMIN));
    expect(res.status).toBe(400);
  });
});

describe('restricted columns', () => {
  it('omits contact details for an actor without the permission', async () => {
    await receive(['SN-1']);

    // Inventory Manager can view customers but not contact details.
    const res = await request(app).get('/api/v1/reports/customer-assets')
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);

    const columns = res.body.data.columns.map((c) => c.key);
    expect(columns).toContain('customerName');
    // The column is ABSENT, not blank: a column of empty cells would announce
    // that the field exists and the reader is not trusted with it.
    expect(columns).not.toContain('customerPhone');
    expect(res.body.meta.withheldColumns).toBeGreaterThan(0);

    // And no row carries the value either — projecting the row matters as much
    // as hiding the header, or the payload leaks what the table does not show.
    expect(JSON.stringify(res.body.data.rows)).not.toContain('9876543210');
  });

  it('includes them for an actor who holds it', async () => {
    const res = await request(app).get('/api/v1/reports/customer-assets')
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);

    expect(res.body.data.columns.map((c) => c.key)).toContain('customerPhone');
    expect(res.body.meta.withheldColumns).toBe(0);
  });

  it('does not leak a restricted column through the CSV export', async () => {
    await receive(['SN-1']);

    const res = await request(app)
      .get('/api/v1/reports/customer-assets/export?format=csv')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);

    const header = res.text.split('\n')[0];
    expect(header).toContain('Customer');
    // The export is the classic place this leaks — a different code path
    // written against raw rows by someone thinking about columns.
    expect(header).not.toContain('Customer phone');
    expect(res.text).not.toContain('9876543210');
  });

  it('does not leak a restricted column through the XLSX export either', async () => {
    await receive(['SN-1']);

    const res = await request(app)
      .get('/api/v1/reports/customer-assets/export?format=xlsx')
      .set(auth(ctx.tokens.INVENTORY_MANAGER))
      .buffer()
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.worksheets[0];

    const headers = sheet.getRow(1).values.filter(Boolean).map(String);
    expect(headers).toContain('Customer');
    expect(headers).not.toContain('Customer phone');

    // Walk every cell: a value can hide in a column we did not expect.
    let found = false;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (String(cell.value ?? '').includes('9876543210')) found = true;
      });
    });
    expect(found).toBe(false);
  });

  it('refuses to export without EXPORT_DATA, even for a readable report', async () => {
    // Reading on screen and taking a copy away are different decisions.
    const res = await request(app)
      .get('/api/v1/reports/stock-on-hand/export?format=csv')
      .set(auth(ctx.tokens.WAREHOUSE_OPERATOR));

    expect(res.status).toBe(403);
  });
});

describe('export content', () => {
  it('writes a UTF-8 BOM so Excel does not mangle non-ASCII', async () => {
    const res = await request(app).get('/api/v1/reports/stock-on-hand/export?format=csv')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
  });

  it('keeps types in the XLSX rather than flattening to text', async () => {
    await receive(['SN-1', 'SN-2']);

    const res = await request(app).get('/api/v1/reports/stock-on-hand/export?format=xlsx')
      .set(auth(ctx.tokens.ADMIN))
      .buffer()
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.worksheets[0];
    const headers = sheet.getRow(1).values.filter(Boolean).map(String);

    const availableAt = headers.indexOf('Available') + 1;
    expect(typeof sheet.getRow(2).getCell(availableAt).value).toBe('number');
  });

  it('records every export in the audit log, with the columns served', async () => {
    await request(app).get('/api/v1/reports/stock-on-hand/export?format=csv')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    const log = await AuditLog.findOne({ action: 'DATA_EXPORTED' });
    expect(log).toBeTruthy();
    expect(log.metadata.format).toBe('CSV');
    // The column list is the evidence that restricted ones were withheld.
    expect(Array.isArray(log.metadata.columns)).toBe(true);
  });
});

describe('reports read from the same source as the screens', () => {
  it('reports stock split by bucket, not as one number', async () => {
    await receive(['SN-1', 'SN-2', 'SN-3']);

    const res = await request(app).get('/api/v1/reports/stock-on-hand')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    const row = res.body.data.rows.find((r) => r.sku === 'SRV-1');
    expect(row.available).toBe(3);
    // The GRN accepted 3 and damaged 2 — a single "quantity" column would hide
    // that 2 of the 5 cannot be sold.
    expect(row.damaged).toBe(2);
    expect(row.total).toBe(5);
    expect(row.belowReorder).toBe('YES');
  });

  it('bands stock by age', async () => {
    await receive(['SN-1']);

    const res = await request(app).get('/api/v1/reports/stock-ageing')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    const row = res.body.data.rows.find((r) => r.serialNumber === 'SN-1');
    expect(row.ageBand).toBe('0–30');
    expect(row.ageDays).toBeLessThanOrEqual(1);
  });

  it('counts a vendor acceptance rate from posted receipts', async () => {
    await receive(['SN-1', 'SN-2', 'SN-3']);

    const res = await request(app).get('/api/v1/reports/vendor-performance')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    const row = res.body.data.rows[0];
    expect(row.vendorName).toBe('Dell');
    expect(row.unitsReceived).toBe(5);
    expect(row.unitsAccepted).toBe(3);
    expect(row.acceptanceRate).toBe(60);
  });

  it('truncates a large on-screen result and says so', async () => {
    const res = await request(app).get('/api/v1/reports/stock-movement')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect(res.body.meta).toHaveProperty('truncated');
    expect(res.body.meta.returned).toBeLessThanOrEqual(1000);
  });
});

describe('notification read state is per user', () => {
  async function raiseTeamAlert() {
    // Addressed to a PERMISSION, so every holder sees the same row.
    await Notification.create({
      tenantId: ctx.company._id,
      recipientPermission: 'VIEW_INVENTORY',
      type: 'TEST_TEAM_ALERT',
      title: 'Reconciliation drift detected',
      severity: 'CRITICAL',
      dedupeKey: `TEST:${Date.now()}`,
    });
  }

  it('does not mark an alert read for the whole team when one person reads it', async () => {
    await raiseTeamAlert();

    const before = await request(app).get('/api/v1/notifications?unreadOnly=true')
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);
    expect(before.body.meta.unread).toBe(1);

    const id = before.body.data[0].id;
    await request(app).patch(`/api/v1/notifications/${id}/read`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);

    // The reader now sees it as read...
    const reader = await request(app).get('/api/v1/notifications/unread-count')
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);
    expect(reader.body.data.unread).toBe(0);

    // ...and a colleague holding the same permission still has it unread.
    // Under the old single `readAt`, this was 0 — a CRITICAL alert silently
    // buried for the whole team because one person glanced at it.
    const colleague = await request(app).get('/api/v1/notifications/unread-count')
      .set(auth(ctx.tokens.ADMIN)).expect(200);
    expect(colleague.body.data.unread).toBe(1);
  });

  it('marks all read for the actor alone', async () => {
    await raiseTeamAlert();
    await raiseTeamAlert();

    await request(app).post('/api/v1/notifications/read-all')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect((await request(app).get('/api/v1/notifications/unread-count')
      .set(auth(ctx.tokens.ADMIN)).expect(200)).body.data.unread).toBe(0);
    expect((await request(app).get('/api/v1/notifications/unread-count')
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200)).body.data.unread).toBe(2);
  });

  it('can be undone, because mark-all-read is easy to mis-click', async () => {
    await raiseTeamAlert();
    const list = await request(app).get('/api/v1/notifications')
      .set(auth(ctx.tokens.ADMIN)).expect(200);
    const id = list.body.data[0].id;

    await request(app).patch(`/api/v1/notifications/${id}/read`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);
    await request(app).patch(`/api/v1/notifications/${id}/unread`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect((await request(app).get('/api/v1/notifications/unread-count')
      .set(auth(ctx.tokens.ADMIN)).expect(200)).body.data.unread).toBe(1);
  });

  it('is idempotent — reading twice does not double-record', async () => {
    await raiseTeamAlert();
    const list = await request(app).get('/api/v1/notifications')
      .set(auth(ctx.tokens.ADMIN)).expect(200);
    const id = list.body.data[0].id;

    await request(app).patch(`/api/v1/notifications/${id}/read`).set(auth(ctx.tokens.ADMIN));
    await request(app).patch(`/api/v1/notifications/${id}/read`).set(auth(ctx.tokens.ADMIN));

    const stored = await Notification.findById(id);
    expect(stored.readBy).toHaveLength(1);
  });

  it('never shows a notification addressed to a permission the actor lacks', async () => {
    await Notification.create({
      tenantId: ctx.company._id,
      recipientPermission: 'MANAGE_SUPER_ADMIN',
      type: 'TEST_PRIVILEGED',
      title: 'Privileged alert',
      severity: 'CRITICAL',
      dedupeKey: `TEST-PRIV:${Date.now()}`,
    });

    const res = await request(app).get('/api/v1/notifications')
      .set(auth(ctx.tokens.VIEWER)).expect(200);

    expect(res.body.data.map((n) => n.type)).not.toContain('TEST_PRIVILEGED');
  });
});

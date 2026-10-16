import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category } from '../../src/models/classification.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { Product } from '../../src/models/Product.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Customer } from '../../src/models/Customer.js';
import { DocumentFile } from '../../src/models/Document.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => { await connectDatabase({ retries: 3, delayMs: 1000 }); });
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

/** Minimal valid files of each accepted type. */
const pdf = () => Buffer.concat([Buffer.from('25504446', 'hex'), Buffer.from('-1.7 invoice')]);
const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
const executable = () => Buffer.concat([Buffer.from('4d5a9000', 'hex'), Buffer.alloc(64)]);

const upload = (token, { file = pdf(), name = 'invoice.pdf', type = 'application/pdf', fields = {} } = {}) => {
  const req = request(app).post('/api/v1/documents').set(auth(token));
  for (const [k, v] of Object.entries({
    entityType: 'PRODUCT', entityId: String(ctx.product._id), ...fields,
  })) req.field(k, String(v));
  return req.attach('file', file, { filename: name, contentType: type });
};

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['SUPER_ADMIN', 'ADMIN', 'INVENTORY_MANAGER', 'SALES_DISPATCH', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT', code: 'IT' });
  const hyd = await Warehouse.create({ tenantId: company._id, name: 'Hyderabad', code: 'WH-HYD' });
  const vendor = await Vendor.create({ tenantId: company._id, vendorName: 'Dell', vendorCode: 'V-DELL' });
  const customer = await Customer.create({
    tenantId: company._id, customerName: 'ACME', customerCode: 'C-ACME',
  });
  const product = await Product.create({
    tenantId: company._id, name: 'Rack Server', sku: 'SRV-1', productCode: 'P1',
    category: category._id, productType: 'SERIALIZED', warrantyMonths: 36, reorderLevel: 5,
  });

  ctx = { company, roles, tokens, category, hyd, vendor, customer, product };
});

describe('upload', () => {
  it('accepts a valid PDF and records it', async () => {
    const res = await upload(ctx.tokens.ADMIN, { fields: { category: 'INVOICE', title: 'Dell invoice' } });

    expect(res.status).toBe(201);
    expect(res.body.data.originalName).toBe('invoice.pdf');
    expect(res.body.data.mimeType).toBe('application/pdf');
    expect(res.body.data.category).toBe('INVOICE');
    // The filesystem location is never exposed.
    expect(res.body.data.storageKey).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('storage');
  });

  it('refuses an executable dressed as a PNG', async () => {
    const res = await upload(ctx.tokens.ADMIN, {
      file: executable(), name: 'totally-an-image.png', type: 'image/png',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_CONTENT_MISMATCH');
    // Nothing was written, so nothing needs cleaning up.
    expect(await DocumentFile.countDocuments({})).toBe(0);
  });

  it('refuses an SVG outright, whatever its bytes say', async () => {
    const res = await upload(ctx.tokens.ADMIN, {
      file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      name: 'logo.svg',
      type: 'image/svg+xml',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('does not let the uploader name decide where the file lands', async () => {
    const res = await upload(ctx.tokens.ADMIN, { name: '../../../etc/passwd.pdf' });

    expect(res.status).toBe(201);
    // The name survives for display; the storage key is ours and random.
    expect(res.body.data.originalName).not.toMatch(/[/\\]/);
    expect(res.body.data.originalName).not.toContain('..'); // TWO independent layers

    const stored = await DocumentFile.findOne({});
    expect(stored.storageKey).not.toContain('..');
    expect(stored.storageKey).not.toContain('passwd');
    expect(stored.storageKey).toMatch(/^[0-9a-f]{24}[/\\][0-9a-f]{2}[/\\][0-9a-f]{64}\.pdf$/);
  });

  it('treats the same bytes on the same record as one document', async () => {
    const first = await upload(ctx.tokens.ADMIN).expect(201);
    const second = await upload(ctx.tokens.ADMIN);

    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await DocumentFile.countDocuments({ deletedAt: null })).toBe(1);
  });

  it('refuses to attach to a record in another tenant', async () => {
    const foreign = await Product.create({
      tenantId: new mongoose.Types.ObjectId(), name: 'Other', sku: 'X-1', productCode: 'X1',
      category: ctx.category._id, productType: 'NON_SERIALIZED',
    });

    const res = await upload(ctx.tokens.ADMIN, { fields: { entityId: String(foreign._id) } });

    // 404, not 403: confirming the record exists would itself be a disclosure.
    expect(res.status).toBe(404);
  });

  it('refuses to attach to a record type the actor cannot view', async () => {
    // Sales can view customers but not vendors.
    const res = await upload(ctx.tokens.SALES_DISPATCH, {
      fields: { entityType: 'VENDOR', entityId: String(ctx.vendor._id) },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PARENT_ACCESS_DENIED');
  });

  it('does not let a viewer upload', async () => {
    expect((await upload(ctx.tokens.VIEWER)).status).toBe(403);
  });
});

describe('download', () => {
  it('returns the bytes with headers that stop the browser executing them', async () => {
    const up = await upload(ctx.tokens.ADMIN, {
      file: Buffer.from('name,qty\nwidget,2'), name: 'stock.csv', type: 'text/csv',
    }).expect(201);

    const res = await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    // A CSV is not inline-safe, so it must download rather than render.
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.text).toBe('name,qty\nwidget,2');
  });

  it('renders a PDF inline but still sandboxed', async () => {
    const up = await upload(ctx.tokens.ADMIN).expect(201);

    const res = await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('strips a filename crafted to inject a header', async () => {
    const up = await upload(ctx.tokens.ADMIN, {
      name: 'evil"\r\nSet-Cookie: admin=1.pdf',
    }).expect(201);

    const res = await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    // The security property is that NO SECOND HEADER was created: the CR and
    // LF are gone, so the value cannot break out of its own header. The words
    // "Set-Cookie" surviving inside a quoted filename is cosmetic — a colon is
    // legal in a quoted-string, and without a line break it starts nothing.
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="[^"]*"$/);
    // The quote that would have closed the filename early is gone too.
    expect(res.headers['content-disposition'].match(/"/g)).toHaveLength(2);
  });

  it('refuses a restricted document without the permission, and records the attempt', async () => {
    const up = await upload(ctx.tokens.ADMIN, {
      fields: { isRestricted: 'true', category: 'INSPECTION_REPORT' },
    }).expect(201);
    expect(up.body.data.isRestricted).toBe(true);

    // Inventory Manager can view products but holds no
    // VIEW_RESTRICTED_DOCUMENTS.
    const res = await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RESTRICTED_DOCUMENT_ACCESS_DENIED');

    const denied = await AuditLog.findOne({ action: 'RESTRICTED_DOCUMENT_DENIED' });
    expect(denied).toBeTruthy();
  });

  it('records every successful download of a restricted document', async () => {
    const up = await upload(ctx.tokens.ADMIN, { fields: { isRestricted: 'true' } }).expect(201);

    await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);

    // Marking a document restricted means access is both controlled and
    // accounted for afterwards.
    const log = await AuditLog.findOne({ action: 'RESTRICTED_DOCUMENT_DOWNLOADED' });
    expect(log).toBeTruthy();
    expect(log.severity).toBe('CRITICAL');
  });

  it('refuses to serve a file whose bytes have changed since upload', async () => {
    const up = await upload(ctx.tokens.ADMIN).expect(201);

    // Simulate tampering or disk corruption by moving the recorded checksum.
    await DocumentFile.updateOne({ _id: up.body.data.id }, { checksum: 'f'.repeat(64) });

    const res = await request(app).get(`/api/v1/documents/${up.body.data.id}/download`)
      .set(auth(ctx.tokens.ADMIN));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DOCUMENT_CORRUPTED');
    expect(await AuditLog.findOne({ action: 'DOCUMENT_CHECKSUM_MISMATCH' })).toBeTruthy();
  });
});

describe('listing', () => {
  it('lists restricted documents but marks them undownloadable', async () => {
    await upload(ctx.tokens.ADMIN, { file: pdf(), name: 'open.pdf' }).expect(201);
    await upload(ctx.tokens.ADMIN, {
      file: png(), name: 'secret.png', type: 'image/png', fields: { isRestricted: 'true' },
    }).expect(201);

    const res = await request(app)
      .get(`/api/v1/documents?entityType=PRODUCT&entityId=${ctx.product._id}`)
      .set(auth(ctx.tokens.INVENTORY_MANAGER)).expect(200);

    expect(res.body.data).toHaveLength(2);
    const secret = res.body.data.find((d) => d.originalName === 'secret.png');
    // Visible as a row — an auditor must be able to see a document exists —
    // but not downloadable. The filename is not the sensitive part.
    expect(secret.isRestricted).toBe(true);
    expect(secret.downloadable).toBe(false);
    expect(res.body.data.find((d) => d.originalName === 'open.pdf').downloadable).toBe(true);
  });

  it('refuses to list documents on a record the actor cannot view', async () => {
    const res = await request(app)
      .get(`/api/v1/documents?entityType=VENDOR&entityId=${ctx.vendor._id}`)
      .set(auth(ctx.tokens.SALES_DISPATCH));

    expect(res.status).toBe(403);
  });
});

describe('deletion', () => {
  it('soft-deletes the record and keeps the bytes', async () => {
    const up = await upload(ctx.tokens.ADMIN).expect(201);

    await request(app).delete(`/api/v1/documents/${up.body.data.id}`)
      .set(auth(ctx.tokens.ADMIN)).send({ reason: 'Filed against the wrong product' }).expect(200);

    const stored = await DocumentFile.findById(up.body.data.id);
    expect(stored.deletedAt).toBeTruthy();

    // A document attached to a receipt is evidence. "Delete" is a filing
    // decision, not permission to destroy the artefact.
    const log = await AuditLog.findOne({ action: 'DOCUMENT_DELETED' });
    expect(log.metadata.bytesRetained).toBe(true);

    const list = await request(app)
      .get(`/api/v1/documents?entityType=PRODUCT&entityId=${ctx.product._id}`)
      .set(auth(ctx.tokens.ADMIN)).expect(200);
    expect(list.body.data).toHaveLength(0);
  });
});

describe('dashboard', () => {
  it('shows a Super Admin every panel', async () => {
    const res = await request(app).get('/api/v1/dashboard')
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);

    expect(res.body.data.availablePanels).toEqual(
      expect.arrayContaining(['stock', 'purchasing', 'sales', 'transfers', 'service', 'returns', 'serials']),
    );
  });

  it('withholds panels the actor has no permission for', async () => {
    const res = await request(app).get('/api/v1/dashboard')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);

    // A count is data. Telling Sales how many purchase orders await approval
    // leaks the existence and volume of purchasing activity.
    expect(res.body.data.panels.purchasing).toBeUndefined();
    expect(res.body.data.availablePanels).not.toContain('purchasing');
    expect(res.body.data.availablePanels).toContain('sales');
  });

  it('omits a withheld panel rather than zeroing it', async () => {
    // Sales, not Viewer: a Viewer legitimately holds VIEW_PURCHASE_ORDER and
    // should see that panel. Sales does not, so the purchasing counts must be
    // wholly absent — not present and set to zero, because zero is an answer.
    const res = await request(app).get('/api/v1/dashboard')
      .set(auth(ctx.tokens.SALES_DISPATCH)).expect(200);

    // Assert on the PANEL, not on a field name: `awaitingApproval` also exists
    // inside the returns panel, which Sales legitimately sees. Matching a bare
    // substring across the whole payload tested the wrong thing.
    expect(res.body.data.panels.purchasing).toBeUndefined();
    expect(res.body.data.availablePanels).not.toContain('purchasing');
    // Present-and-zero would be a leak; absent is the requirement.
    expect('purchasing' in res.body.data.panels).toBe(false);

    // And the manifest never claims a panel that is not in the payload.
    expect(Object.keys(res.body.data.panels).sort())
      .toEqual([...res.body.data.availablePanels].sort());
  });

  it('separates sellable stock from stock that merely exists', async () => {
    const res = await request(app).get('/api/v1/dashboard')
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);

    const stock = res.body.data.panels.stock;
    expect(stock).toHaveProperty('sellableUnits');
    expect(stock).toHaveProperty('totalUnits');
    expect(stock.buckets).toHaveProperty('damaged');
    expect(stock.buckets).toHaveProperty('underService');
  });

  it('builds an attention list gated the same way', async () => {
    const res = await request(app).get('/api/v1/dashboard/attention')
      .set(auth(ctx.tokens.SUPER_ADMIN)).expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('reports storage use', async () => {
    await upload(ctx.tokens.ADMIN, { fields: { category: 'INVOICE' } }).expect(201);

    const res = await request(app).get('/api/v1/documents/storage-summary')
      .set(auth(ctx.tokens.ADMIN)).expect(200);

    expect(res.body.data.documents).toBe(1);
    expect(res.body.data.bytes).toBeGreaterThan(0);
    expect(res.body.data.byCategory[0].category).toBe('INVOICE');
  });
});

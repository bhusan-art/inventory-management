import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Category, Brand } from '../../src/models/classification.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Product } from '../../src/models/Product.js';
import { Warehouse } from '../../src/models/Warehouse.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

let ctx = {};

beforeAll(async () => {
  await connectDatabase({ retries: 3, delayMs: 1000 });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ['ADMIN', 'INVENTORY_MANAGER', 'SALES_DISPATCH', 'VIEWER']) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  const category = await Category.create({ tenantId: company._id, name: 'IT Hardware', code: 'IT-HW' });
  const brand = await Brand.create({ tenantId: company._id, name: 'Dell', code: 'DELL' });

  ctx = { company, roles, tokens, category, brand };
});

describe('classification CRUD', () => {
  it('creates, reads, updates and deletes a category', async () => {
    const create = await request(app).post('/api/v1/categories')
      .set(auth(ctx.tokens.ADMIN))
      .send({ name: 'Networking', code: 'NET' });
    expect(create.status).toBe(201);
    const id = create.body.data.id;

    const read = await request(app).get(`/api/v1/categories/${id}`).set(auth(ctx.tokens.ADMIN));
    expect(read.body.data.code).toBe('NET');

    const update = await request(app).put(`/api/v1/categories/${id}`)
      .set(auth(ctx.tokens.ADMIN)).send({ description: 'Switches and routers' });
    expect(update.body.data.description).toBe('Switches and routers');

    const remove = await request(app).delete(`/api/v1/categories/${id}`).set(auth(ctx.tokens.ADMIN));
    expect(remove.status).toBe(200);

    // Soft deleted: gone from the API, still in the collection.
    expect((await request(app).get(`/api/v1/categories/${id}`).set(auth(ctx.tokens.ADMIN))).status).toBe(404);
    expect(await Category.countDocuments({ _id: id })).toBe(1);
  });

  it('rejects a duplicate code among live records', async () => {
    const res = await request(app).post('/api/v1/categories')
      .set(auth(ctx.tokens.ADMIN)).send({ name: 'Another', code: 'IT-HW' });
    expect(res.status).toBe(409);
    expect(res.body.errors[0].code).toBe('DUPLICATE_VALUE');
  });

  it('frees a code once the record is deleted', async () => {
    const created = await request(app).post('/api/v1/categories')
      .set(auth(ctx.tokens.ADMIN)).send({ name: 'Temp', code: 'TEMP' });
    await request(app).delete(`/api/v1/categories/${created.body.data.id}`).set(auth(ctx.tokens.ADMIN));

    const reuse = await request(app).post('/api/v1/categories')
      .set(auth(ctx.tokens.ADMIN)).send({ name: 'Temp Again', code: 'TEMP' });
    expect(reuse.status).toBe(201);
  });

  it('allows the same subcategory name under different parents', async () => {
    const other = await Category.create({ tenantId: ctx.company._id, name: 'Electrical', code: 'ELEC' });

    const first = await request(app).post('/api/v1/subcategories').set(auth(ctx.tokens.ADMIN))
      .send({ name: 'Switches', code: 'NET-SW', category: String(ctx.category._id) });
    const second = await request(app).post('/api/v1/subcategories').set(auth(ctx.tokens.ADMIN))
      .send({ name: 'Switches', code: 'ELEC-SW', category: String(other._id) });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe('reference-in-use deletion blocking', () => {
  it('refuses to delete a category that still has products', async () => {
    await Product.create({
      tenantId: ctx.company._id, name: 'Server', sku: 'SRV-1', productCode: 'PC-1',
      category: ctx.category._id, productType: 'SERIALIZED',
    });

    const res = await request(app)
      .delete(`/api/v1/categories/${ctx.category._id}`)
      .set(auth(ctx.tokens.ADMIN));

    expect(res.status).toBe(409);
    expect(res.body.errors[0].code).toBe('REFERENCE_IN_USE');
    // Naming the blocker lets the user act on it instead of guessing.
    expect(res.body.errors[0].collection).toBe('Product');
    expect(res.body.errors[0].count).toBe(1);
  });

  it('allows the delete once the blocking product is gone', async () => {
    const product = await Product.create({
      tenantId: ctx.company._id, name: 'Server', sku: 'SRV-1', productCode: 'PC-1',
      category: ctx.category._id, productType: 'SERIALIZED',
    });
    await Product.updateOne({ _id: product._id }, { deletedAt: new Date() });

    const res = await request(app)
      .delete(`/api/v1/categories/${ctx.category._id}`)
      .set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
  });

  it('refuses to delete a warehouse that users are scoped to', async () => {
    const warehouse = await Warehouse.create({ tenantId: ctx.company._id, name: 'Hyd', code: 'WH-HYD' });
    await createUser({
      company: ctx.company, role: ctx.roles.WAREHOUSE_OPERATOR, email: 'scoped@test.local',
      overrides: { scope: { warehouseIds: [warehouse._id] } },
    });

    const res = await request(app).delete(`/api/v1/warehouses/${warehouse._id}`).set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(409);
  });
});

describe('restricted fields on vendors', () => {
  let vendorId;

  beforeEach(async () => {
    const vendor = await Vendor.create({
      tenantId: ctx.company._id,
      vendorName: 'Dell India',
      vendorCode: 'V-DELL',
      phone: '+919812345678',
      email: 'sales@dell.example',
      bankDetails: { accountName: 'Dell India', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC' },
    });
    vendorId = String(vendor._id);
  });

  it('omits contact and bank fields for roles without the permissions', async () => {
    const res = await request(app).get(`/api/v1/vendors/${vendorId}`).set(auth(ctx.tokens.INVENTORY_MANAGER));

    expect(res.status).toBe(200);
    expect('phone' in res.body.data).toBe(false);
    expect('email' in res.body.data).toBe(false);
    expect('bankDetails' in res.body.data).toBe(false);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('9812345678');
    expect(body).not.toContain('123456789012');
  });

  it('masks the account number even for holders of the permission', async () => {
    const res = await request(app).get(`/api/v1/vendors/${vendorId}`).set(auth(ctx.tokens.ADMIN));

    expect(res.body.data.phone).toBe('+919812345678');
    expect(res.body.data.bankDetails.accountNumberMasked).toBe('••••9012');
    expect(JSON.stringify(res.body)).not.toContain('123456789012');
  });

  it('returns the full account number only from the dedicated endpoint, and audits it', async () => {
    const res = await request(app)
      .get(`/api/v1/vendors/${vendorId}/bank-details`)
      .set(auth(ctx.tokens.ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data.bankDetails.accountNumber).toBe('123456789012');

    const entry = await AuditLog.findOne({ action: 'VENDOR_BANK_DETAILS_VIEWED' });
    expect(entry?.severity).toBe('WARNING');
  });

  it('refuses the bank-details endpoint to roles without the permission', async () => {
    const res = await request(app)
      .get(`/api/v1/vendors/${vendorId}/bank-details`)
      .set(auth(ctx.tokens.SALES_DISPATCH));
    expect(res.status).toBe(403);
  });

  it('blocks sorting and filtering by a restricted field', async () => {
    const sorted = await request(app).get('/api/v1/vendors?sort=phone:asc').set(auth(ctx.tokens.INVENTORY_MANAGER));
    expect(sorted.status).toBe(403);
    expect(sorted.body.errors[0].code).toBe('RESTRICTED_FIELD_ACCESS_DENIED');

    const filtered = await request(app).get('/api/v1/vendors?filter[email]=x').set(auth(ctx.tokens.INVENTORY_MANAGER));
    expect(filtered.status).toBe(403);
  });

  it('keeps restricted values out of audit diffs', async () => {
    await request(app).put(`/api/v1/vendors/${vendorId}`)
      .set(auth(ctx.tokens.ADMIN))
      .send({ phone: '+919999000011', vendorName: 'Dell India Pvt Ltd' });

    const entry = await AuditLog.findOne({ action: 'VENDOR_UPDATED' });
    expect(JSON.stringify(entry.changes)).not.toContain('9999000011');
  });
});

describe('product rules', () => {
  it('rejects a serial format on a non-serialized product', async () => {
    const res = await request(app).post('/api/v1/products').set(auth(ctx.tokens.ADMIN)).send({
      name: 'Patch Cord', sku: 'PC-1', productCode: 'P-1',
      category: String(ctx.category._id), productType: 'NON_SERIALIZED',
      serialFormatPattern: '^SN[0-9]+$',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid regex as a serial format', async () => {
    const res = await request(app).post('/api/v1/products').set(auth(ctx.tokens.ADMIN)).send({
      name: 'Server', sku: 'SRV-2', productCode: 'P-2',
      category: String(ctx.category._id), productType: 'SERIALIZED',
      serialFormatPattern: '^SN([0-9]+$',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('rejects a reference to a category from outside the tenant', async () => {
    const { company: other } = await seedTenant();
    const foreign = await Category.create({ tenantId: other._id, name: 'Foreign', code: 'FGN' });

    const res = await request(app).post('/api/v1/products').set(auth(ctx.tokens.ADMIN)).send({
      name: 'Server', sku: 'SRV-3', productCode: 'P-3',
      category: String(foreign._id), productType: 'SERIALIZED',
    });
    expect(res.status).toBe(404);
  });

  it('rejects a reference to an inactive category', async () => {
    await Category.updateOne({ _id: ctx.category._id }, { status: 'INACTIVE' });
    const res = await request(app).post('/api/v1/products').set(auth(ctx.tokens.ADMIN)).send({
      name: 'Server', sku: 'SRV-4', productCode: 'P-4',
      category: String(ctx.category._id), productType: 'SERIALIZED',
    });
    expect(res.status).toBe(422);
  });

  it('enforces min ≤ reorder ≤ max', async () => {
    const res = await request(app).post('/api/v1/products').set(auth(ctx.tokens.ADMIN)).send({
      name: 'Server', sku: 'SRV-5', productCode: 'P-5',
      category: String(ctx.category._id), productType: 'SERIALIZED',
      minStockLevel: 50, reorderLevel: 10, maxStockLevel: 20,
    });
    expect(res.status).toBe(400);
  });

  it('escapes regex metacharacters in search', async () => {
    await Product.create({
      tenantId: ctx.company._id, name: 'Server', sku: 'SRV-6', productCode: 'P-6',
      category: ctx.category._id, productType: 'SERIALIZED',
    });

    // Unescaped, ".*" would match every product rather than none.
    const res = await request(app).get('/api/v1/products?search=.*').set(auth(ctx.tokens.ADMIN));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('product CSV import', () => {
  const header = 'name,sku,productCode,category,brand,productType,unitOfMeasure\n';

  it('reports what would happen without writing anything', async () => {
    const csv = `${header}Server A,SRV-A,PC-A,IT-HW,DELL,SERIALIZED,PCS\n`;

    const res = await request(app).post('/api/v1/products/import')
      .set(auth(ctx.tokens.ADMIN)).send({ csv, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(1);
    expect(res.body.data.imported).toBe(0);
    expect(await Product.countDocuments({ tenantId: ctx.company._id })).toBe(0);
  });

  it('imports every row or none — one bad row blocks the file', async () => {
    const csv = `${header}` +
      'Server A,SRV-A,PC-A,IT-HW,DELL,SERIALIZED,PCS\n' +
      'Server B,SRV-B,PC-B,NOPE,DELL,SERIALIZED,PCS\n';

    const res = await request(app).post('/api/v1/products/import')
      .set(auth(ctx.tokens.ADMIN)).send({ csv, dryRun: false });

    expect(res.body.data.invalid).toBe(1);
    expect(res.body.data.imported).toBe(0);
    // The valid row must not have landed — a partial import is unrecoverable
    // by hand across a large file.
    expect(await Product.countDocuments({ tenantId: ctx.company._id })).toBe(0);
    expect(res.body.data.errors[0].line).toBe(3);
  });

  it('imports a clean file', async () => {
    const csv = `${header}` +
      'Server A,SRV-A,PC-A,IT-HW,DELL,SERIALIZED,PCS\n' +
      'Cable 24F,OFC-24,PC-B,IT Hardware,DELL,NON_SERIALIZED,MTR\n';

    const res = await request(app).post('/api/v1/products/import')
      .set(auth(ctx.tokens.ADMIN)).send({ csv, dryRun: false });

    expect(res.body.data.imported).toBe(2);
    expect(await Product.countDocuments({ tenantId: ctx.company._id, deletedAt: null })).toBe(2);
  });

  it('catches duplicates within the file itself', async () => {
    const csv = `${header}` +
      'Server A,SRV-A,PC-A,IT-HW,DELL,SERIALIZED,PCS\n' +
      'Server A again,SRV-A,PC-B,IT-HW,DELL,SERIALIZED,PCS\n';

    const res = await request(app).post('/api/v1/products/import')
      .set(auth(ctx.tokens.ADMIN)).send({ csv, dryRun: false });

    expect(res.body.data.invalid).toBe(1);
    expect(res.body.data.errors[0].issues.join(' ')).toMatch(/duplicated in this file/);
  });

  it('refuses the import to roles without CREATE_PRODUCT', async () => {
    const res = await request(app).post('/api/v1/products/import')
      .set(auth(ctx.tokens.VIEWER)).send({ csv: `${header}A,B,C,IT-HW,DELL,SERIALIZED,PCS\n` });
    expect(res.status).toBe(403);
  });
});

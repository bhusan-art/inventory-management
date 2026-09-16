import {
  vendorSchemas, productSchemas, customerSchemas, warehouseSchemas,
} from '../../src/validators/master.schema.js';

describe('vendor validation', () => {
  const valid = { vendorName: 'Dell India', vendorCode: 'V-DELL' };

  it('accepts a minimal vendor', () => {
    expect(vendorSchemas.create.body.safeParse(valid).success).toBe(true);
  });

  it('rejects a malformed GSTIN', () => {
    // A bad GSTIN is only discovered when a statutory document is rejected, so
    // it is checked structurally rather than as a 15-character string.
    expect(vendorSchemas.create.body.safeParse({ ...valid, gstin: '12ABCDE' }).success).toBe(false);
    expect(vendorSchemas.create.body.safeParse({ ...valid, gstin: '36AABCS1429B1ZB' }).success).toBe(true);
  });

  it('rejects a malformed IFSC', () => {
    const bad = { ...valid, bankDetails: { accountNumber: '123456789', ifsc: 'HDFC1234567' } };
    expect(vendorSchemas.create.body.safeParse(bad).success).toBe(false);

    const good = { ...valid, bankDetails: { accountNumber: '123456789', ifsc: 'HDFC0001234' } };
    expect(vendorSchemas.create.body.safeParse(good).success).toBe(true);
  });

  it('rejects a non-numeric account number', () => {
    const bad = { ...valid, bankDetails: { accountNumber: 'not-a-number' } };
    expect(vendorSchemas.create.body.safeParse(bad).success).toBe(false);
  });
});

describe('product validation', () => {
  const valid = {
    name: 'Rack Server',
    productCode: 'PC-0001',
    sku: 'SRV-1',
    category: '6612f0a3c9d1e4b2a7f83e10',
    productType: 'SERIALIZED',
  };

  it('accepts a minimal serialized product', () => {
    expect(productSchemas.create.body.safeParse(valid).success).toBe(true);
  });

  it('requires a product type — there is no safe default', () => {
    const { productType, ...withoutType } = valid;
    expect(productType).toBeDefined();
    expect(productSchemas.create.body.safeParse(withoutType).success).toBe(false);
  });

  it('rejects a serial format on a non-serialized product', () => {
    const result = productSchemas.create.body.safeParse({
      ...valid, productType: 'NON_SERIALIZED', serialFormatPattern: '^SN[0-9]+$',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an HSN code that is not 4-8 digits', () => {
    expect(productSchemas.create.body.safeParse({ ...valid, hsnCode: '12' }).success).toBe(false);
    expect(productSchemas.create.body.safeParse({ ...valid, hsnCode: '84713010' }).success).toBe(true);
  });

  it('uppercases SKU and product code so lookups are consistent', () => {
    const parsed = productSchemas.create.body.parse({ ...valid, sku: 'srv-1', productCode: 'pc-0001' });
    expect(parsed.sku).toBe('SRV-1');
    expect(parsed.productCode).toBe('PC-0001');
  });

  it('rejects negative stock levels', () => {
    expect(productSchemas.create.body.safeParse({ ...valid, minStockLevel: -1 }).success).toBe(false);
  });
});

describe('customer validation', () => {
  it('defaults to an external customer', () => {
    const parsed = customerSchemas.create.body.parse({ customerName: 'ACME', customerCode: 'C-ACME' });
    expect(parsed.customerType).toBe('EXTERNAL');
  });

  it('accepts internal and project-site classifications', () => {
    for (const customerType of ['INTERNAL_DEPARTMENT', 'PROJECT_SITE']) {
      const result = customerSchemas.create.body.safeParse({
        customerName: 'Site', customerCode: 'C-SITE', customerType,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects a postal code that is not six digits', () => {
    const result = customerSchemas.create.body.safeParse({
      customerName: 'ACME', customerCode: 'C-ACME', billingAddress: { postalCode: '50008' },
    });
    expect(result.success).toBe(false);
  });
});

describe('warehouse validation', () => {
  it('refuses to create TRANSIT or SCRAP warehouses through the API', () => {
    // Exactly one of each must exist; the transfer and write-off flows assume it.
    for (const type of ['TRANSIT', 'SCRAP']) {
      const result = warehouseSchemas.create.body.safeParse({ name: 'Test Warehouse', code: 'WH-X', type });
      expect(result.success).toBe(false);
    }
  });

  it('accepts the operational warehouse types', () => {
    for (const type of ['MAIN', 'BRANCH', 'SERVICE_CENTER']) {
      expect(
        warehouseSchemas.create.body.safeParse({ name: 'Test Warehouse', code: 'WH-X', type }).success,
      ).toBe(true);
    }
  });
});

describe('subcategory indexing', () => {
  it('scopes name uniqueness to the parent category, not the tenant', async () => {
    // "Switches" must be able to exist under both Networking and Electrical.
    // A global {tenantId, name} unique index would prevent that, and adding a
    // narrower index alongside it does not help — Mongoose creates both.
    const { Subcategory } = await import('../../src/models/classification.js');

    const unique = Subcategory.schema.indexes()
      .filter(([, opts]) => opts.unique)
      .map(([keys]) => Object.keys(keys).join('+'));

    expect(unique).toContain('tenantId+category+name');
    expect(unique).not.toContain('tenantId+name');
  });
});

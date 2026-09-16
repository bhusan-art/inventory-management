import { Product } from '../../models/Product.js';
import { Category, Subcategory, Brand, Manufacturer } from '../../models/classification.js';
import { productSchemas } from '../../validators/master.schema.js';
import { writeAudit } from '../shared/auditService.js';
import { DomainError } from '../../utils/errors.js';

const MAX_ROWS = 5000;

/**
 * CSV product import.
 *
 * Always validates the entire file before writing anything, and defaults to a
 * dry run. A partial import is the worst outcome available here: the operator
 * cannot tell which rows landed, re-running duplicates the successful ones,
 * and fixing it by hand across a few thousand products is a day lost.
 *
 * So: parse every row, resolve every reference, collect every error, and only
 * then decide whether to write. All rows or none.
 */
export async function importProducts(actor, { csv, dryRun = true }) {
  const rows = parseCsv(csv);

  if (rows.length === 0) throw new DomainError('The file contains no data rows', 'EMPTY_IMPORT');
  if (rows.length > MAX_ROWS) {
    throw new DomainError(`Imports are limited to ${MAX_ROWS} rows per file`, 'IMPORT_TOO_LARGE');
  }

  const lookups = await buildLookups(actor.tenantId);
  const existingSkus = new Set(
    (await Product.find({ tenantId: actor.tenantId, deletedAt: null }).select('sku').lean())
      .map((p) => p.sku),
  );
  const existingCodes = new Set(
    (await Product.find({ tenantId: actor.tenantId, deletedAt: null }).select('productCode').lean())
      .map((p) => p.productCode),
  );

  const errors = [];
  const prepared = [];
  const seenSku = new Set();
  const seenCode = new Set();

  rows.forEach((row, index) => {
    const line = index + 2; // header is line 1
    const issues = [];

    const payload = {
      name: row.name,
      sku: (row.sku ?? '').toUpperCase(),
      productCode: (row.productCode ?? row.product_code ?? '').toUpperCase(),
      productType: (row.productType ?? row.product_type ?? '').toUpperCase(),
      unitOfMeasure: (row.unitOfMeasure ?? row.uom ?? 'PCS').toUpperCase(),
      modelNumber: row.modelNumber ?? row.model ?? undefined,
      description: row.description || undefined,
      hsnCode: row.hsnCode || row.hsn || undefined,
      warrantyMonths: toInt(row.warrantyMonths ?? row.warranty_months, 0),
      minStockLevel: toInt(row.minStockLevel ?? row.min_stock, 0),
      reorderLevel: toInt(row.reorderLevel ?? row.reorder_level, 0),
      maxStockLevel: toInt(row.maxStockLevel ?? row.max_stock, 0),
    };

    // References arrive as human-readable codes, not ObjectIds — nobody types
    // an ObjectId into a spreadsheet.
    const categoryId = lookups.category.get(up(row.category));
    if (!categoryId) issues.push(`unknown category "${row.category ?? ''}"`);
    else payload.category = categoryId;

    if (row.subcategory) {
      const id = lookups.subcategory.get(up(row.subcategory));
      if (!id) issues.push(`unknown subcategory "${row.subcategory}"`);
      else payload.subcategory = id;
    }
    if (row.brand) {
      const id = lookups.brand.get(up(row.brand));
      if (!id) issues.push(`unknown brand "${row.brand}"`);
      else payload.brand = id;
    }
    if (row.manufacturer) {
      const id = lookups.manufacturer.get(up(row.manufacturer));
      if (!id) issues.push(`unknown manufacturer "${row.manufacturer}"`);
      else payload.manufacturer = id;
    }

    if (existingSkus.has(payload.sku)) issues.push(`SKU ${payload.sku} already exists`);
    if (existingCodes.has(payload.productCode)) issues.push(`product code ${payload.productCode} already exists`);
    // Duplicates inside the file itself, which the database checks above miss.
    if (seenSku.has(payload.sku)) issues.push(`SKU ${payload.sku} is duplicated in this file`);
    if (seenCode.has(payload.productCode)) issues.push(`product code ${payload.productCode} is duplicated in this file`);
    seenSku.add(payload.sku);
    seenCode.add(payload.productCode);

    const parsed = productSchemas.create.body.safeParse(payload);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`));
    }

    if (issues.length > 0) errors.push({ line, sku: payload.sku || null, issues });
    else prepared.push({ ...parsed.data, tenantId: actor.tenantId, createdBy: actor.id });
  });

  const summary = {
    totalRows: rows.length,
    valid: prepared.length,
    invalid: errors.length,
    errors: errors.slice(0, 100),
    truncatedErrors: Math.max(0, errors.length - 100),
    dryRun,
    imported: 0,
  };

  if (errors.length > 0) {
    summary.message = 'No products were imported. Fix the rows listed and upload again.';
    return summary;
  }

  if (dryRun) {
    summary.message = `${prepared.length} rows are valid and ready to import.`;
    return summary;
  }

  await Product.insertMany(prepared, { ordered: true });
  summary.imported = prepared.length;
  summary.message = `${prepared.length} products imported.`;

  await writeAudit({
    action: 'PRODUCT_BULK_IMPORT',
    module: 'Product',
    severity: 'CRITICAL',
    tenantId: actor.tenantId,
    metadata: { count: prepared.length },
  });

  return summary;
}

const up = (v) => String(v ?? '').trim().toUpperCase();
const toInt = (v, fallback) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

async function buildLookups(tenantId) {
  const [categories, subcategories, brands, manufacturers] = await Promise.all([
    Category.find({ tenantId, deletedAt: null }).select('code name').lean(),
    Subcategory.find({ tenantId, deletedAt: null }).select('code name').lean(),
    Brand.find({ tenantId, deletedAt: null }).select('code name').lean(),
    Manufacturer.find({ tenantId, deletedAt: null }).select('code name').lean(),
  ]);

  // Accept either the code or the name, since spreadsheets contain both.
  const index = (docs) => {
    const map = new Map();
    for (const d of docs) {
      map.set(up(d.code), d._id);
      map.set(up(d.name), d._id);
    }
    return map;
  };

  return {
    category: index(categories),
    subcategory: index(subcategories),
    brand: index(brands),
    manufacturer: index(manufacturers),
  };
}

/**
 * Minimal RFC 4180 parser: quoted fields, escaped quotes, embedded commas and
 * newlines. Written rather than pulled in as a dependency because the surface
 * needed here is small and fully specified.
 */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }

  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (nonEmpty.length < 2) return [];

  const headers = nonEmpty[0].map((h) => String(h).trim());
  return nonEmpty.slice(1).map((cells) =>
    headers.reduce((obj, header, idx) => {
      obj[header] = String(cells[idx] ?? '').trim();
      return obj;
    }, {}),
  );
}

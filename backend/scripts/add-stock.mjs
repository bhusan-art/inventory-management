#!/usr/bin/env node
/**
 * Add stock from the command line.
 *
 * THIS IS A STOPGAP. Stock should be entered through the application, and
 * there is currently no screen that does it — the frontend is read-only apart
 * from raising a service ticket. This script exists so the system is usable
 * while that is built, not as the intended way to run a warehouse.
 *
 * Two modes, and the difference matters:
 *
 *   --via-grn   The REAL path. Creates a purchase order, approves it, receives
 *               goods against it and posts the receipt. Stock arrives with a
 *               vendor, a PO number, a GRN number and a full audit trail, which
 *               is what an auditor expects to find and what the reports assume.
 *
 *   (default)   A direct adjustment. One call, no paperwork. Correct for
 *               opening balances when you are loading what is already on the
 *               shelf, and wrong for anything that actually arrived from a
 *               vendor — an adjustment records that the number changed, not
 *               where the goods came from.
 *
 * Usage:
 *   node scripts/add-stock.mjs --email admin@example.com --password 'secret' \
 *        --sku OFC-1 --warehouse WH-HYD --quantity 500
 *
 *   node scripts/add-stock.mjs ... --via-grn --vendor V-DELL
 *   node scripts/add-stock.mjs ... --list        # show SKUs and warehouse codes
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const CONFIG = {
  url: String(flag('url', 'http://localhost:5000')).replace(/\/$/, ''),
  email: flag('email'),
  password: flag('password'),
  sku: flag('sku'),
  warehouse: flag('warehouse'),
  vendor: flag('vendor'),
  quantity: Number(flag('quantity', 0)),
  viaGrn: flag('via-grn', false) === true,
  list: flag('list', false) === true,
  reason: String(flag('reason', 'FOUND_STOCK')),
};

if (!CONFIG.email || !CONFIG.password) {
  console.error('Need --email and --password.');
  process.exit(2);
}

// Initialised rather than bare so `api` can close over it before sign-in.
let token = null;

async function api(method, path, body) {
  // fetch wraps every transport failure as a bare `TypeError: fetch failed`,
  // so the real reason — ECONNREFUSED, ETIMEDOUT — is only on the cause.
  let res;
  try {
    res = await fetch(`${CONFIG.url}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const reason = err.cause?.code ?? err.cause?.message ?? err.message;
    throw new Error(`Cannot reach ${CONFIG.url} (${reason}). Is the stack running?`);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    // The machine code, not the prose — that is what the contract says to
    // match on, and it is what makes a failure here diagnosable.
    const detail = (payload?.errors ?? []).map((e) => `${e.field ?? ''} ${e.message ?? e.code}`.trim());
    throw new Error(
      `${method} ${path} → ${res.status} ${payload?.code ?? ''} ${payload?.message ?? ''}`
      + (detail.length ? `\n    ${detail.join('\n    ')}` : ''),
    );
  }
  return payload;
}

const first = (rows, label, needle) => {
  const hit = rows.find((r) => [r.sku, r.code, r.productCode, r.vendorCode, r.name, r.vendorName]
    .filter(Boolean)
    .some((v) => String(v).toUpperCase() === String(needle).toUpperCase()));
  if (!hit) {
    throw new Error(
      `No ${label} matching "${needle}". Available:\n`
      + rows.map((r) => `    ${(r.sku ?? r.code ?? r.vendorCode ?? '?').padEnd(14)} ${r.name ?? r.vendorName ?? ''}`).join('\n'),
    );
  }
  return hit;
};

// ---------------------------------------------------------------- main

/**
 * Wrapped in main() rather than left at the top level.
 *
 * A top-level `await` that rejects in an ES module is NOT reported through
 * `process.on('unhandledRejection')` — Node prints a raw stack trace instead.
 * For a tool whose entire output is "did the stock go in", a stack is noise
 * and the message is the answer.
 */
async function main() {
  const login = await api('POST', '/api/v1/auth/login', {
    email: CONFIG.email, password: CONFIG.password,
  });
  token = login.data.accessToken;

  const [products, warehouses] = await Promise.all([
    api('GET', '/api/v1/products?limit=200'),
    api('GET', '/api/v1/warehouses?limit=200'),
  ]);

  if (CONFIG.list) {
    console.log('\nPRODUCTS');
    for (const p of products.data) {
      console.log(`  ${String(p.sku).padEnd(14)} ${String(p.productType).padEnd(16)} ${p.name}`);
    }
    console.log('\nWAREHOUSES');
    for (const w of warehouses.data) console.log(`  ${String(w.code).padEnd(14)} ${w.name}`);
    const vendors = await api('GET', '/api/v1/vendors?limit=200').catch(() => ({ data: [] }));
    console.log('\nVENDORS');
    for (const v of vendors.data) console.log(`  ${String(v.vendorCode).padEnd(14)} ${v.vendorName}`);
    console.log('');
    process.exit(0);
  }

  if (!CONFIG.sku || !CONFIG.warehouse || !(CONFIG.quantity > 0)) {
    console.error('Need --sku, --warehouse and a positive --quantity. Try --list first.');
    process.exit(2);
  }

  const product = first(products.data, 'product', CONFIG.sku);
  const warehouse = first(warehouses.data, 'warehouse', CONFIG.warehouse);

  if (product.productType === 'SERIALIZED') {
    // Each unit needs its own serial number, which this script does not invent:
    // a made-up serial becomes a permanent, untraceable record attached to a
    // real physical asset.
    console.error(
      `${product.sku} is SERIALIZED. Every unit needs a real serial number, so it has to be\n`
      + 'received through a GRN carrying those serials rather than added in bulk here.',
    );
    process.exit(2);
  }

  if (CONFIG.viaGrn) {
    if (!CONFIG.vendor) {
      console.error('--via-grn needs --vendor (the goods came from somewhere). Try --list.');
      process.exit(2);
    }
    const vendors = await api('GET', '/api/v1/vendors?limit=200');
    const vendor = first(vendors.data, 'vendor', CONFIG.vendor);

    console.log(`Purchase order: ${CONFIG.quantity} × ${product.sku} from ${vendor.vendorName}…`);
    const po = await api('POST', '/api/v1/purchase-orders', {
      vendor: vendor.id,
      warehouse: warehouse.id,
      lines: [{ product: product.id, orderedQuantity: CONFIG.quantity }],
      remarks: 'Opening stock, entered via add-stock.mjs',
    });
    const poId = po.data.id;
    console.log(`  ${po.data.poNumber}`);

    await api('POST', `/api/v1/purchase-orders/${poId}/approve`, {});
    console.log('  approved');

    const grn = await api('POST', '/api/v1/grn', {
      vendor: vendor.id,
      purchaseOrder: poId,
      warehouse: warehouse.id,
      lines: [{
        product: product.id,
        receivedQuantity: CONFIG.quantity,
        acceptedQuantity: CONFIG.quantity,
        damagedQuantity: 0,
        rejectedQuantity: 0,
      }],
      remarks: 'Opening stock',
    });
    console.log(`  ${grn.data.grnNumber} created`);

    // Creating a GRN does NOT move stock. Posting it does — that separation is
    // deliberate, so a receipt can be checked before it becomes inventory.
    await api('POST', `/api/v1/grn/${grn.data.id}/post`, {});
    console.log('  posted');
  } else {
    console.log(`Adjusting ${product.sku} at ${warehouse.code}…`);
    const existing = await api(
      'GET',
      `/api/v1/inventory?product=${product.id}&warehouse=${warehouse.id}&limit=1`,
    );
    // `newQuantity` is an ABSOLUTE target, not a delta, so the current level has
    // to be read first or this silently *replaces* stock instead of adding to it.
    const current = Number(existing.data?.[0]?.available ?? 0);

    await api('POST', '/api/v1/inventory/adjust', {
      product: product.id,
      warehouse: warehouse.id,
      bucket: 'AVAILABLE',
      newQuantity: current + CONFIG.quantity,
      reasonCode: CONFIG.reason,
      remarks: 'Opening stock, entered via add-stock.mjs',
    });
    console.log(`  ${current} → ${current + CONFIG.quantity}`);
  }

  const after = await api(
    'GET',
    `/api/v1/inventory?product=${product.id}&warehouse=${warehouse.id}&limit=1`,
  );
  const row = after.data?.[0];
  console.log(`\n${product.name} @ ${warehouse.name}: available ${row?.available ?? 0}, total ${row?.total ?? 0}`);
  console.log('Open http://localhost:5173/inventory to see it.\n');
}

main().catch((err) => {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
});

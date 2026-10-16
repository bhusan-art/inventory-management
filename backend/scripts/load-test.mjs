#!/usr/bin/env node
/**
 * Load test — concurrency against a RUNNING server.
 *
 * Written for one question in particular. Phase 8 produced a dispatch
 * `TRANSACTION_CONFLICT` (251, NoSuchTransaction) that I could not explain:
 * mongod logged no aborted transaction, and the test passed in isolation. I
 * proposed three mechanisms and all three were wrong. What I never did was
 * measure it — so the honest next step is an instrument rather than a fourth
 * theory.
 *
 * This is therefore a MEASUREMENT TOOL, not a pass/fail gate. It reports
 * latency distribution and the exact error codes returned under concurrency. It
 * does not assert a threshold, because a threshold I invented would tell you
 * only whether reality matched my guess.
 *
 * It runs against a real server over HTTP — not supertest — because the thing
 * under suspicion is the interaction between concurrent requests, connection
 * pooling and a majority write concern. In-process requests share a single
 * event loop and would not reproduce it.
 *
 * Usage:
 *   node scripts/load-test.mjs --url http://localhost:5000 \
 *        --email admin@example.com --password 'secret' \
 *        --scenario read --concurrency 20 --requests 400
 *
 *   --scenario read      GET /api/v1/products          (no transaction)
 *   --scenario dispatch  POST a dispatch note           (the suspect path)
 *   --scenario adjust    POST an inventory adjustment   (guarded $inc)
 *
 * READ IS SAFE. The write scenarios MUTATE DATA and must not be pointed at a
 * live system; the script refuses unless --i-know-this-writes is passed.
 */

const args = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const CONFIG = {
  url: String(flag('url', 'http://localhost:5000')).replace(/\/$/, ''),
  email: flag('email'),
  password: flag('password'),
  scenario: String(flag('scenario', 'read')),
  concurrency: Number(flag('concurrency', 10)),
  requests: Number(flag('requests', 200)),
  warmup: Number(flag('warmup', 10)),
  confirmWrites: flag('i-know-this-writes', false) === true,
};

const WRITE_SCENARIOS = new Set(['dispatch', 'adjust']);

if (!CONFIG.email || !CONFIG.password) {
  console.error('Need --email and --password. Use a test account.');
  process.exit(2);
}

if (WRITE_SCENARIOS.has(CONFIG.scenario) && !CONFIG.confirmWrites) {
  console.error(
    `Scenario "${CONFIG.scenario}" CREATES AND MODIFIES RECORDS.\n`
    + 'Point it at a disposable database and pass --i-know-this-writes.',
  );
  process.exit(2);
}

// ---------------------------------------------------------------- http

async function call(method, path, { token, body } = {}) {
  const started = process.hrtime.bigint();

  let res;
  let payload = null;
  try {
    res = await fetch(`${CONFIG.url}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Read the body even on failure: the error CODE is the whole point of this
    // exercise, and discarding it would leave only "some 409s happened".
    payload = await res.json().catch(() => null);
  } catch (err) {
    // fetch wraps everything as a bare `TypeError: fetch failed`, so the real
    // reason — ECONNREFUSED, ECONNRESET, ETIMEDOUT — is only on the cause. In
    // a diagnostic tool, "TypeError" is not a finding.
    const reason = err.cause?.code ?? err.cause?.message ?? err.code ?? err.name;
    return {
      ms: Number(process.hrtime.bigint() - started) / 1e6,
      status: 0,
      code: `TRANSPORT:${reason}`,
    };
  }

  return {
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    status: res.status,
    code: payload?.code ?? (res.ok ? 'OK' : `HTTP_${res.status}`),
    body: payload,
  };
}

async function signIn() {
  const res = await call('POST', '/api/v1/auth/login', {
    body: { email: CONFIG.email, password: CONFIG.password },
  });
  if (res.status !== 200) {
    console.error(`Sign-in failed: ${res.status} ${res.code}`);
    process.exit(1);
  }
  return res.body.data.accessToken;
}

// ---------------------------------------------------------------- scenarios

async function prepare(token) {
  if (CONFIG.scenario === 'read') {
    return { send: () => call('GET', '/api/v1/products?limit=20', { token }) };
  }

  if (CONFIG.scenario === 'adjust') {
    const products = await call('GET', '/api/v1/products?limit=1&productType=NON_SERIALIZED', { token });
    const warehouses = await call('GET', '/api/v1/warehouses?limit=1', { token });

    const product = products.body?.data?.[0];
    const warehouse = warehouses.body?.data?.[0];
    if (!product || !warehouse) {
      console.error('Need at least one non-serialized product and one warehouse.');
      process.exit(1);
    }

    // The current level is needed because the adjustment sets an absolute
    // quantity; without reading it first the run would reset stock to a number
    // the script invented.
    const current = await call(
      'GET',
      `/api/v1/inventory?product=${product.id}&warehouse=${warehouse.id}&limit=1`,
      { token },
    );

    console.log(`Adjusting ${product.name} at ${warehouse.name} — alternating two absolute levels.`);

    /**
     * `newQuantity` is an ABSOLUTE target, not a delta.
     *
     * The first version of this sent `quantity: ±1` to `/inventory/adjustments`
     * — wrong route, wrong field, wrong semantics. It would have 404'd on every
     * request and reported a clean "0% success" that looked like a server
     * problem rather than a script problem.
     *
     * Alternating between two neighbouring absolute values keeps the run
     * stock-neutral over an even number of requests, and never asks for a
     * negative quantity the domain would rightly refuse.
     */
    const base = Number(current.body?.data?.[0]?.available ?? 0);
    let n = 0;
    return {
      send: () => {
        n += 1;
        return call('POST', '/api/v1/inventory/adjust', {
          token,
          body: {
            product: product.id,
            warehouse: warehouse.id,
            bucket: 'AVAILABLE',
            newQuantity: n % 2 === 1 ? base + 1 : base,
            reasonCode: 'DATA_CORRECTION',
            remarks: 'automated load test',
          },
        });
      },
    };
  }

  if (CONFIG.scenario === 'dispatch') {
    const orders = await call('GET', '/api/v1/sales-orders?status=APPROVED&limit=50', { token });
    const approved = orders.body?.data ?? [];
    if (approved.length === 0) {
      console.error('No APPROVED sales orders to dispatch against.');
      process.exit(1);
    }

    console.log(`Dispatching against ${approved.length} approved order(s).`);

    // Round-robin across orders. Hammering ONE order would serialize on its
    // own document and measure lock contention instead of the transaction
    // behaviour this is here to observe.
    let i = 0;
    return {
      send: () => {
        const order = approved[i++ % approved.length];
        return call('POST', '/api/v1/dispatch-notes', {
          token,
          body: { salesOrder: order.id, remarks: 'load test' },
        });
      },
    };
  }

  console.error(`Unknown scenario "${CONFIG.scenario}".`);
  return process.exit(2);
}

// ---------------------------------------------------------------- runner

/** Keeps exactly `concurrency` requests in flight until the budget is spent. */
async function run(send, total, concurrency) {
  const results = [];
  let issued = 0;

  const worker = async () => {
    while (issued < total) {
      issued += 1;
      results.push(await send());
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function report(results, elapsedMs) {
  // Latency is measured over SUCCESSFUL requests only. A rate-limited reply is
  // a fast rejection — it never touched the database — so folding those into
  // the percentiles flatters every figure exactly when the run is least
  // representative.
  const ok2xx = results.filter((r) => r.status >= 200 && r.status < 300);
  const times = ok2xx.map((r) => r.ms).sort((a, b) => a - b);
  const byCode = results.reduce((acc, r) => {
    acc[r.code] = (acc[r.code] ?? 0) + 1;
    return acc;
  }, {});

  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;

  console.log('\n──────────────── results ────────────────');
  console.log(`scenario        ${CONFIG.scenario}`);
  console.log(`requests        ${results.length} at concurrency ${CONFIG.concurrency}`);
  console.log(`wall clock      ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`throughput      ${(results.length / (elapsedMs / 1000)).toFixed(1)} req/s`);
  console.log(`succeeded       ${ok} (${((ok / results.length) * 100).toFixed(1)}%)`);
  console.log('\nlatency (ms, successful requests only)');
  console.log(`  min    ${times[0]?.toFixed(1)}`);
  console.log(`  p50    ${percentile(times, 50).toFixed(1)}`);
  console.log(`  p95    ${percentile(times, 95).toFixed(1)}`);
  console.log(`  p99    ${percentile(times, 99).toFixed(1)}`);
  console.log(`  max    ${times[times.length - 1]?.toFixed(1)}`);

  console.log('\nresponse codes');
  for (const [code, count] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
    const share = ((count / results.length) * 100).toFixed(1);
    console.log(`  ${code.padEnd(26)} ${String(count).padStart(5)}  ${share}%`);
  }

  /**
   * The one thing this script was built to see. No verdict is offered: the
   * number is the finding, and a threshold invented here would only measure
   * my own expectations.
   */
  /**
   * Rate limiting is the tool hitting a ceiling the server was configured to
   * enforce — not a failure. Reported as "succeeded 72.3%" it reads like the
   * system fell over under load, which is the opposite of what happened.
   */
  const limited = byCode.RATE_LIMITED ?? 0;
  if (limited > 0) {
    const perMinute = Math.round((results.length / (elapsedMs / 1000)) * 60);
    console.log(
      `\nRATE LIMITED: ${limited} of ${results.length} requests were refused by the server's own\n`
      + `rate limiter, which is it working. This run offered roughly ${perMinute} requests/minute\n`
      + 'against a ceiling of 300/minute (globalLimiter in src/middleware/rateLimit.js).\n'
      + 'To measure throughput rather than the limiter, either lower --concurrency and\n'
      + '--requests below the ceiling, or raise the limit for the duration of the test.\n'
      + 'The latency figures above cover only the requests that were actually served.',
    );
  }

  const conflicts = byCode.TRANSACTION_CONFLICT ?? 0;
  if (conflicts > 0) {
    console.log(
      `\nTRANSACTION_CONFLICT: ${conflicts} of ${results.length} `
      + `(${((conflicts / results.length) * 100).toFixed(1)}%) — `
      + 'the Phase 8 open item. Compare against docker compose logs mongo '
      + 'filtered on "transaction" for the same window.',
    );
  } else {
    console.log('\nNo TRANSACTION_CONFLICT at this concurrency.');
  }
  console.log('');
}

// ---------------------------------------------------------------- main

const token = await signIn();
const { send } = await prepare(token);

if (CONFIG.warmup > 0) {
  // Discarded. The first requests pay for connection setup, index warming and
  // JIT, and folding them into p99 reports a startup cost as a latency tail.
  console.log(`Warming up (${CONFIG.warmup} requests, discarded)…`);
  await run(send, CONFIG.warmup, Math.min(CONFIG.warmup, CONFIG.concurrency));
}

console.log(`Running ${CONFIG.requests} requests at concurrency ${CONFIG.concurrency}…`);
const started = Date.now();
const results = await run(send, CONFIG.requests, CONFIG.concurrency);
report(results, Date.now() - started);

/**
 * Every sidebar link must lead to a screen.
 *
 * Exists because Phase 4 shipped a "Stock Counts" link with no route behind it.
 * The config edit that should have added the screen matched nothing and did
 * nothing, silently, and the router's catch-all quietly redirected the link to
 * the dashboard — so nothing crashed and nothing failed.
 *
 * A link that goes nowhere is a bug the app will never report on its own. This
 * check makes it one CI will.
 */
import { readFileSync } from 'node:fs';
import { NAVIGATION } from '../src/constants/navigation.js';
import { MASTER_CONFIGS } from '../src/features/master/masterConfig.js';

/**
 * The standalone routes are READ FROM THE ROUTER, not listed here.
 *
 * They used to be a hand-maintained `STANDALONE_ROUTES` set — which is the
 * same defect this script exists to catch, one level up. Adding a route and
 * its sidebar link correctly still failed the check until somebody remembered
 * to update a third list, and the obvious way to make the check pass is to add
 * the path here rather than to add the route. A guard that can be satisfied
 * without fixing anything is worse than no guard.
 *
 * Parsing the file is cheap and cannot drift: a path reaches this set only by
 * existing in `routes.jsx`.
 */
const routerSource = readFileSync(new URL('../src/app/routes.jsx', import.meta.url), 'utf8');
const declared = [...routerSource.matchAll(/path=(?:"([^"]+)"|\{`([^`$]+)`\})/g)]
  .map((m) => m[1] ?? m[2])
  .filter((p) => p.startsWith('/') && !p.includes('*') && !p.includes(':'));

if (declared.length === 0) {
  console.error('Parsed no routes out of routes.jsx — the pattern has gone stale.');
  process.exit(1);
}

const links = NAVIGATION.flatMap((entry) => (entry.section ? entry.items : [entry]));
const routed = new Set([...declared, ...Object.keys(MASTER_CONFIGS).map((k) => `/${k}`)]);

const dead = links.filter((l) => !routed.has(l.to));

/**
 * The reverse is also worth knowing: a screen nobody can navigate to.
 *
 * "Linked" means more than the sidebar. A screen reached by a button on
 * another screen — "New order" on the purchase order list — is reachable, and
 * reporting it as URL-only trains people to ignore this section, which is
 * where a genuinely orphaned screen would appear.
 */
const headerActions = Object.values(MASTER_CONFIGS)
  .map((c) => c.headerAction?.to)
  .filter(Boolean);

const linked = new Set([...links.map((l) => l.to), ...headerActions]);
const orphaned = [...routed].filter((r) => !linked.has(r));

// And a link must be gated by the same permission as the screen it opens,
// otherwise the sidebar offers a page the route then refuses.
const mismatched = links
  .map((l) => ({ l, config: MASTER_CONFIGS[l.to.slice(1)] }))
  .filter(({ l, config }) => config && config.permissions.view !== l.permission)
  .map(({ l, config }) => `${l.to}: link needs ${l.permission}, screen needs ${config.permissions.view}`);

let failed = false;

if (dead.length) {
  failed = true;
  console.error('Navigation links with no screen behind them:');
  for (const l of dead) console.error(`  ${l.label.padEnd(20)} ${l.to}`);
}
if (mismatched.length) {
  failed = true;
  console.error('Navigation permission does not match screen permission:');
  for (const m of mismatched) console.error(`  ${m}`);
}
if (orphaned.length) {
  console.warn('Screens with no navigation link (reachable only by URL):');
  for (const r of orphaned) console.warn(`  ${r}`);
}

if (failed) process.exit(1);
console.log(`Navigation OK — ${links.length} links, all routed.`);

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
import { NAVIGATION } from '../src/constants/navigation.js';
import { MASTER_CONFIGS } from '../src/features/master/masterConfig.js';

// Routes defined directly in app/routes.jsx rather than generated from config.
const STANDALONE_ROUTES = new Set(['/']);

const links = NAVIGATION.flatMap((entry) => (entry.section ? entry.items : [entry]));
const routed = new Set([...STANDALONE_ROUTES, ...Object.keys(MASTER_CONFIGS).map((k) => `/${k}`)]);

const dead = links.filter((l) => !routed.has(l.to));

// The reverse is also worth knowing: a screen nobody can navigate to.
const linked = new Set(links.map((l) => l.to));
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

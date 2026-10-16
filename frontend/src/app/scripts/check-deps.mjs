#!/usr/bin/env node
/**
 * Does the installed tree match the lock file?
 *
 * This exists because the same failure has now cost two debugging sessions,
 * wearing a different disguise each time.
 *
 * The dev compose mounts an ANONYMOUS volume over /app/node_modules so the
 * container keeps its own Linux-built dependencies instead of the host's. That
 * volume survives `docker compose up --build`. So a rebuild installs the new
 * dependencies into the IMAGE, the stale volume hides them at runtime, and the
 * container runs a tree that matches no lock file anywhere:
 *
 *   Phase 10:  Cannot find module 'multer'
 *   Phase 15:  Host version "0.28.2" does not match binary version "0.21.5"
 *
 * Neither message mentions volumes, Docker, or the actual cause. Both sent
 * someone looking at the wrong thing — the second time, me.
 *
 * `node_modules/.package-lock.json` is npm's record of what it actually
 * installed. Comparing it against `package-lock.json` catches the mismatch
 * before Vite starts and says what to type.
 */
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
};

const FIX = `
  docker compose up -d --build --renew-anon-volumes frontend

(--renew-anon-volumes only recreates ANONYMOUS volumes. mongo-data and
backend-storage are named, so your database and uploads are untouched.)
`;

const lockPath = new URL('../package-lock.json', import.meta.url);
const installedPath = new URL('../node_modules/.package-lock.json', import.meta.url);

if (!existsSync(installedPath)) {
  // Nothing installed at all — a plain `npm install` away, not a volume issue.
  console.error('\nnode_modules is missing or was never installed by npm.\n\n  npm install\n');
  process.exit(1);
}

const lock = read('../package-lock.json');
const installed = read('../node_modules/.package-lock.json');

if (!lock || !installed) {
  // Cannot tell — say so and let the dev server start rather than blocking on
  // a check that is itself broken.
  console.warn('check-deps: could not read a lock file; skipping the check.');
  process.exit(0);
}

const versionOf = (tree, name) => tree?.packages?.[`node_modules/${name}`]?.version;

const mismatched = Object.keys(lock.packages ?? {})
  .filter((key) => key.startsWith('node_modules/'))
  .map((key) => key.slice('node_modules/'.length))
  .map((name) => ({ name, want: versionOf(lock, name), got: versionOf(installed, name) }))
  .filter(({ want, got }) => want && got && want !== got);

/**
 * Optional packages are allowed to be absent.
 *
 * The first version of this reported a CLEAN tree as broken, because
 * `fsevents` is marked `optional: true, os: ["darwin"]` — a macOS file watcher
 * that npm correctly declines to install on Linux. A guard that cries wolf on
 * a healthy container is worse than no guard: the first thing anyone does
 * with it is stop reading its output.
 */
const isOptional = (name) => Boolean(lock.packages?.[`node_modules/${name}`]?.optional);

const missing = Object.keys(lock.packages ?? {})
  .filter((key) => key.startsWith('node_modules/'))
  .map((key) => key.slice('node_modules/'.length))
  .filter((name) => !isOptional(name))
  .filter((name) => versionOf(installed, name) === undefined);

if (mismatched.length === 0 && missing.length === 0) process.exit(0);

console.error('\nThe installed packages do not match package-lock.json.\n');

if (missing.length > 0) {
  console.error(`  missing (${missing.length}): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`);
}
for (const { name, want, got } of mismatched.slice(0, 6)) {
  console.error(`  ${name}: installed ${got}, lock says ${want}`);
}
if (mismatched.length > 6) console.error(`  …and ${mismatched.length - 6} more`);

console.error(
  '\nInside Docker this is almost always the stale node_modules volume shadowing'
  + '\nthe rebuilt image. Rebuild it with:\n'
  + FIX,
);
process.exit(1);

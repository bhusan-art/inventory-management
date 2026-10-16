/**
 * Every write inside a `withTransaction` callback must carry the session.
 *
 * `transaction.js` claims this in its own doc comment:
 *
 *   "A single place to enforce that the session is threaded through. Every
 *    repository call inside the callback receives `session` explicitly; a write
 *    that forgets it silently escapes the transaction, which is the hardest bug
 *    in this class of system to find later."
 *
 * Nothing enforced it. `dispatchService` drew its dispatch note number with
 * `nextDocumentNumber('DN')` — no session — from inside the transaction, and
 * the comment had been describing an intention rather than a guarantee for
 * five phases.
 *
 * What it cost: the un-sessioned upsert wrote `counters` outside the
 * transaction, the transaction then wrote the same collection through
 * ledgerService at an older snapshot, the write conflicted, and after three
 * retries the request returned 409 TRANSACTION_CONFLICT. Separately, the
 * un-sessioned `$inc` survived the abort, so each retry silently burned a
 * dispatch note number.
 *
 * Scope: the counter helpers, because an escaped `$inc` cannot be rolled back
 * and so is the one that corrupts a sequence rather than merely losing a write.
 * Model calls take `.session(session)` in a dozen shapes and are left to
 * review; this catches the shape that actually bit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(relative));
    else if (entry.name.endsWith('.js')) out.push(relative);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** The source span of each `withTransaction(...)` call, parens balanced. */
function transactionBodies(src) {
  const bodies = [];
  const re = /withTransaction\(/g;
  let m;

  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;

    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push({ body: src.slice(open, i + 1), offset: open });
          break;
        }
      }
    }
  }

  return bodies;
}

const offenders = [];

for (const relative of jsFiles('src')) {
  const raw = readFileSync(path.join(root, relative), 'utf8');
  const src = stripComments(raw);

  for (const { body, offset } of transactionBodies(src)) {
    for (const call of body.matchAll(/next(?:DocumentNumber|Sequence)\([^)]*\)/g)) {
      if (call[0].includes('session')) continue;

      offenders.push({
        file: relative,
        line: src.slice(0, offset + call.index).split('\n').length,
        call: call[0],
      });
    }
  }
}

if (offenders.length > 0) {
  console.error('Counter call inside a transaction without the session:');
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.call}`);
  console.error('\nAn un-sessioned $inc escapes the transaction and is not rolled back.');
  console.error('Pass { session } so the number is drawn and discarded with it.');
  process.exit(1);
}

console.log('Session threading OK — every transactional counter call carries its session.');

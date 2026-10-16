/**
 * A multi-document `create()` inside a session must pass `ordered: true`.
 *
 * Mongoose refuses the call outright without it:
 *
 *   MongooseError: Cannot call `create()` with a session and multiple
 *   documents unless `ordered: true` is set
 *
 * Exists because `SerialNumberEvent.create(created.map(...), { session })` in
 * serialService shipped in Phase 3 and survived five phases. Posting a GRN with
 * ONE serialized unit worked; two or more returned a 500. Every manual check
 * and every fixture used one serial, so nothing ever hit it — the first thing
 * that did was a Phase 8 test helper receiving three units.
 *
 * The lesson is not "remember the option". It is that a rule nothing enforces
 * is a rule that holds until the first person forgets. So it is checked here.
 *
 * A single-element array cannot trigger the error at runtime, but it is flagged
 * anyway: the array may grow, and a uniform pattern is one that copy-and-paste
 * spreads correctly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Walked by hand rather than with `fs.globSync`.
 *
 * `globSync` landed in Node 22; the backend container runs Node 20, so the
 * first version of this script died with "does not provide an export named
 * 'globSync'" in Docker while passing outside it. A CI check that only runs on
 * the newer runtime is not a CI check.
 */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(relative));
    else if (entry.name.endsWith('.js')) out.push(relative);
  }
  return out;
}

const files = jsFiles('src');

/**
 * Comments are stripped before anything is matched.
 *
 * Without this the check passed for the wrong reason: the comment explaining
 * why `ordered: true` is required contains the words "ordered: true", so a
 * substring search found it and declared the call site fine while the actual
 * option was missing. A check that cannot fail is not a check, and the only
 * reason this was caught is that the regression was deliberately re-introduced
 * to watch it fail.
 *
 * Replaced with spaces rather than deleted, so reported line numbers still
 * match the real file.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Returns the source span of every `X.create(...)` call, parens balanced. */
function createCalls(src) {
  const calls = [];
  const re = /(\w+)\.create\(/g;
  let m;

  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;

    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          calls.push({ model: m[1], body: src.slice(open, i + 1), index: m.index });
          break;
        }
      }
    }
  }

  return calls;
}

const offenders = [];

for (const relative of files) {
  const src = stripComments(readFileSync(path.join(root, relative), 'utf8'));

  for (const call of createCalls(src)) {
    if (!call.body.includes('session')) continue;

    const firstArg = call.body.replace(/^\(\s*/, '');
    const isMultiDocument = firstArg.startsWith('[') || call.body.includes('.map(');
    if (!isMultiDocument) continue;

    if (call.body.includes('ordered: true')) continue;

    offenders.push({
      file: relative,
      line: src.slice(0, call.index).split('\n').length,
      model: call.model,
    });
  }
}

if (offenders.length > 0) {
  console.error('Multi-document create() inside a session without `ordered: true`:');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.model}.create(...)`);
  }
  console.error('\nMongoose rejects these at runtime. Add `ordered: true` to the options.');
  process.exit(1);
}

console.log('Transactional create() calls OK — all multi-document writes are ordered.');

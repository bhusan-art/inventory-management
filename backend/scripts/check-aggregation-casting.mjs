/**
 * An aggregation `$match` on an id must cast it.
 *
 * Mongoose casts `find({ tenantId })` against the schema. It does NOT cast
 * `aggregate([{ $match: { tenantId } }])` — a pipeline goes to the server
 * nearly verbatim, with no per-stage schema to cast against. So a string id is
 * compared to stored ObjectIds, matches nothing, and the pipeline returns an
 * empty result with no error.
 *
 * `actor.tenantId` is a string. Seven pipelines matched on it directly and were
 * silently returning nothing: the dashboard's stock and activity panels, the
 * document storage summary, and `auditSerialConsistency` — whose entire job is
 * proving two numbers agree, which it cannot do against an empty set.
 *
 * A crash would have been kinder. Zero looks like an answer: a dashboard
 * reading "0 units" reads as an empty warehouse, not a broken query. Phase 10
 * only found it because a test asserted a specific non-zero number.
 *
 * This flags an id-shaped key inside a pipeline whose value is neither cast via
 * `toObjectId` nor already an ObjectId expression (`x._id`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Keys whose values are ObjectIds in this schema. */
const ID_KEYS = [
  'tenantId', 'product', 'warehouse', 'customer', 'vendor', 'serialNumber',
  'warranty', 'dispatchNote', 'salesOrder', 'purchaseOrder', 'grn', 'entityId',
];

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

/** The source span of each `.aggregate(...)` call, brackets balanced. */
function aggregateCalls(src) {
  const calls = [];
  const re = /\.aggregate\(/g;
  let m;

  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;

    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          calls.push({ body: src.slice(open, i + 1), index: m.index });
          break;
        }
      }
    }
  }

  return calls;
}

const offenders = [];

/** Only `$match` stages matter — a `$group` referencing '$product' is fine. */
function matchStages(body) {
  const stages = [];
  const re = /\$match\s*:\s*\{/g;
  let m;

  while ((m = re.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;

    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          stages.push(body.slice(open, i + 1));
          break;
        }
      }
    }
  }

  return stages;
}

for (const relative of jsFiles('src')) {
  const src = stripComments(readFileSync(path.join(root, relative), 'utf8'));

  // Identifiers this file proved it cast: `const tenant = toObjectId(...)`.
  const castLocals = new Set(
    [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*toObjectId\(/g)].map((m) => m[1]),
  );

  for (const call of aggregateCalls(src)) {
    const line = () => src.slice(0, call.index).split('\n').length;

    for (const stage of matchStages(call.body)) {
      for (const key of ID_KEYS) {
        // Shorthand `{ tenantId }` — never cast.
        if (new RegExp(`[{,]\\s*${key}\\s*[,}]`).test(stage)) {
          offenders.push({ file: relative, line: line(), text: `${key} (shorthand — not cast)` });
          continue;
        }

        const m = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(stage);
        if (!m) continue;

        const value = m[1].trim();
        const ok = value.includes('toObjectId')
          || value.endsWith('._id')
          || value.startsWith('{')          // an operator expression
          || castLocals.has(value);         // a local proven cast above

        if (!ok) {
          offenders.push({ file: relative, line: line(), text: `${key}: ${value}` });
        }
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('Aggregation $match on an id without casting:');
  for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.text}`);
  console.error('\nA pipeline gets no schema casting: a string id matches nothing and');
  console.error('the stage returns EMPTY, with no error. Wrap it in toObjectId().');
  process.exit(1);
}

console.log('Aggregation casting OK — every pipeline id is cast.');

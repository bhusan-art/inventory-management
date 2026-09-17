import { nextSequence } from '../../models/Counter.js';

/**
 * Document numbering: PO/2026-27/00042.
 *
 * Scoped per financial year and per document type, drawn from an atomic
 * counter inside the caller's transaction (see Counter.js for why a count()+1
 * is not acceptable here).
 */
const WIDTH = 5;

export function financialYear(date = new Date(), startMonth = 4) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const start = month >= startMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export async function nextDocumentNumber(prefix, { session, date = new Date(), fyStartMonth = 4 } = {}) {
  const fy = financialYear(date, fyStartMonth);
  const seq = await nextSequence(`${prefix}:${fy}`, { session });
  return `${prefix}/${fy}/${String(seq).padStart(WIDTH, '0')}`;
}

export default nextDocumentNumber;

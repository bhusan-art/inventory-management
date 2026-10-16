import { ScanLine, X } from 'lucide-react';

/**
 * Product lines with quantities, and serial capture where the product needs it.
 *
 * Transfers, sales orders and dispatch notes all take the same shape — a list
 * of (product, quantity) with serials for serialized units — and all three
 * servers enforce the same rule: `serials.length !== quantity` is refused with
 * `SERIAL_COUNT_MISMATCH`. Written three times, those three screens would drift
 * apart and each would discover the rule separately, in production.
 *
 * `requiresSerials` is a prop rather than an assumption, because a sales order
 * does NOT take serials at creation: units are reserved when the order is
 * confirmed, and asking for them a step early would mean promising specific
 * units before anything has been set aside.
 */

export const emptyLine = () => ({
  product: null, quantity: null, serialNumbers: [], serialDraft: '', serialError: null, remarks: '',
});

/** What is wrong with this line, or null. The caller blocks submit on it. */
export function lineProblem(line, productsById, { requiresSerials }) {
  if (!line.product) return null;
  const quantity = Number(line.quantity || 0);
  if (quantity < 1) return 'Enter a quantity';

  const product = productsById[line.product];
  if (requiresSerials && product?.productType === 'SERIALIZED'
      && line.serialNumbers.length !== quantity) {
    return `${line.serialNumbers.length} of ${quantity} serials captured`;
  }
  return null;
}

export default function LineEditor({
  lines, setLines, products, productsById, requiresSerials = false,
  quantityLabel = 'Quantity', disabledProducts = new Set(),
}) {
  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addSerial = (i, raw) => {
    const serial = String(raw ?? '').trim().toUpperCase();
    if (!serial) return;
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      // Caught here rather than by a unique-index violation after submit,
      // which would reject the whole document over one mis-scan.
      if (l.serialNumbers.includes(serial)) {
        return { ...l, serialDraft: '', serialError: `${serial} already scanned on this line` };
      }
      return { ...l, serialNumbers: [...l.serialNumbers, serial], serialDraft: '', serialError: null };
    }));
  };

  const input = 'rounded-control border border-line-strong px-3 py-2 text-sm';

  return (
    <div className="divide-y divide-line/70">
      {lines.map((line, i) => {
        const product = productsById[line.product];
        const serialized = requiresSerials && product?.productType === 'SERIALIZED';
        const quantity = Number(line.quantity || 0);
        const problem = lineProblem(line, productsById, { requiresSerials });

        return (
          <div key={line.key ?? i} className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block min-w-[16rem] flex-1">
                <span className="mb-1 block text-xs font-medium text-ink-soft">Product</span>
                <select
                  value={line.product ?? ''}
                  onChange={(e) => setLine(i, {
                    product: e.target.value || null,
                    // Serials belong to the product that was scanned for. Keeping
                    // them across a product change would attach real serials to
                    // the wrong item.
                    serialNumbers: [], serialDraft: '', serialError: null,
                  })}
                  className={`${input} w-full bg-white`}
                >
                  <option value="">—</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id} disabled={disabledProducts.has(p.id) && line.product !== p.id}>
                      {p.sku} — {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block w-32">
                <span className="mb-1 block text-xs font-medium text-ink-soft">{quantityLabel}</span>
                <input
                  type="number" min={1} value={line.quantity ?? ''} className={`${input} w-full`}
                  onChange={(e) => setLine(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>

              <label className="block min-w-[10rem] flex-1">
                <span className="mb-1 block text-xs font-medium text-ink-soft">Line remarks</span>
                <input
                  value={line.remarks ?? ''} maxLength={300} className={`${input} w-full`}
                  onChange={(e) => setLine(i, { remarks: e.target.value })}
                />
              </label>

              <button
                type="button" aria-label="Remove line"
                onClick={() => setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((_, idx) => idx !== i)))}
                className="mb-1 rounded-md p-2 text-ink-muted hover:bg-paper hover:text-ink-soft"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {serialized && (
              <div className="rounded-md border border-line bg-paper p-3">
                <div className="flex items-center gap-2">
                  <ScanLine className="h-4 w-4 text-ink-muted" />
                  <input
                    value={line.serialDraft ?? ''} placeholder="Scan or type a serial, then Enter"
                    className="flex-1 rounded-control border border-line-strong px-3 py-2 font-mono text-sm"
                    onChange={(e) => setLine(i, { serialDraft: e.target.value })}
                    onKeyDown={(e) => {
                      // A scanner sends the serial then Enter. Letting that
                      // submit the form would post a half-filled document.
                      if (e.key !== 'Enter') return;
                      e.preventDefault();
                      addSerial(i, line.serialDraft);
                    }}
                  />
                  <span className={`text-sm ${
                    line.serialNumbers.length === quantity && quantity > 0
                      ? 'text-emerald-700' : 'text-ink-muted'
                  }`}
                  >
                    {line.serialNumbers.length} / {quantity || 0}
                  </span>
                </div>

                {line.serialError && <p className="mt-2 text-xs text-rose-700">{line.serialError}</p>}

                {line.serialNumbers.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {line.serialNumbers.map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          onClick={() => setLine(i, {
                            serialNumbers: line.serialNumbers.filter((x) => x !== s),
                          })}
                          className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-mono text-xs text-ink-soft ring-1 ring-slate-200 hover:bg-rose-50 hover:text-rose-700"
                        >
                          {s} <X className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {problem && <p className="text-xs text-amber-700">{problem}</p>}
          </div>
        );
      })}
    </div>
  );
}

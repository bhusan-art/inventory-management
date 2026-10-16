import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import DocumentShell from '../../components/documents/DocumentShell.jsx';
import LineEditor, { emptyLine, lineProblem } from '../../components/documents/LineEditor.jsx';

/**
 * Moving stock between warehouses.
 *
 * Serials are captured at creation here, unlike a sales order. A transfer
 * names the physical units that will be put on a vehicle, and the server
 * reserves exactly those — so the decision belongs to whoever is loading, not
 * to a later step.
 */
export default function TransferFormPage() {
  const navigate = useNavigate();

  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [header, setHeader] = useState({
    sourceWarehouse: null, destinationWarehouse: null, vehicleNumber: '', remarks: '',
  });
  const [lines, setLines] = useState([emptyLine()]);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/warehouses', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/products', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([wh, pr]) => { setWarehouses(wh.data.data); setProducts(pr.data.data); });
  }, []);

  const productsById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p])), [products],
  );

  const filled = lines.filter((l) => l.product && Number(l.quantity) > 0);
  const sameWarehouse = header.sourceWarehouse
    && header.sourceWarehouse === header.destinationWarehouse;

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!header.sourceWarehouse || !header.destinationWarehouse) {
      setMessage('Choose where the stock is coming from and where it is going.');
      return;
    }
    // The server refuses this too, but saying so here costs a round trip less
    // and explains itself next to the field.
    if (sameWarehouse) {
      setMessage('Source and destination must be different warehouses.');
      return;
    }
    if (filled.length === 0) {
      setMessage('Add at least one line with a product and a quantity.');
      return;
    }
    const problems = filled.map((l) => lineProblem(l, productsById, { requiresSerials: true }));
    if (problems.some(Boolean)) {
      setMessage('Some lines are incomplete — see the messages against them.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/transfers', {
        sourceWarehouse: header.sourceWarehouse,
        destinationWarehouse: header.destinationWarehouse,
        vehicleNumber: header.vehicleNumber || undefined,
        remarks: header.remarks || undefined,
        lines: filled.map((l) => ({
          product: l.product,
          requestedQuantity: Number(l.quantity),
          serialNumbers: productsById[l.product]?.productType === 'SERIALIZED' ? l.serialNumbers : [],
          remarks: l.remarks || undefined,
        })),
      });
      navigate('/transfers');
    } catch (err) {
      const byField = fieldErrors(err);
      setMessage(
        Object.keys(byField).length > 0
          ? `${toMessage(err, 'Rejected')} — ${Object.entries(byField).map(([k, v]) => `${k}: ${v}`).join('; ')}`
          : toMessage(err, 'Could not create the transfer'),
      );
      setSaving(false);
    }
  };

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';

  return (
    <form onSubmit={submit} noValidate>
      <DocumentShell
        backTo="/transfers"
        title="New transfer"
        subtitle="Move stock from one warehouse to another."
        error={message}
      >
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                From <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.sourceWarehouse ?? ''} className={`${input} bg-white`}
                onChange={(e) => setHeader((h) => ({ ...h, sourceWarehouse: e.target.value || null }))}
              >
                <option value="">—</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                To <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.destinationWarehouse ?? ''}
                className={`${input} bg-white ${sameWarehouse ? 'border-rose-400' : ''}`}
                onChange={(e) => setHeader((h) => ({ ...h, destinationWarehouse: e.target.value || null }))}
              >
                <option value="">—</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              {sameWarehouse && (
                <span className="mt-1 block text-xs text-rose-700">
                  Must differ from the source.
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Vehicle number</span>
              <input
                value={header.vehicleNumber} maxLength={20} className={`${input} font-mono`}
                onChange={(e) => setHeader((h) => ({ ...h, vehicleNumber: e.target.value.toUpperCase() }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Remarks</span>
              <input
                value={header.remarks} maxLength={500} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, remarks: e.target.value }))}
              />
            </label>
          </div>
        </section>

        <section className="rounded-panel border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Lines</h2>
            <span className="text-sm text-ink-muted">
              {filled.length} line{filled.length === 1 ? '' : 's'}
            </span>
          </div>

          <LineEditor
            lines={lines} setLines={setLines}
            products={products} productsById={productsById}
            requiresSerials
            quantityLabel="Quantity"
          />

          <div className="border-t border-line px-4 py-3">
            <button
              type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}
              className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
            >
              <Plus className="h-4 w-4" /> Add line
            </button>
          </div>
        </section>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button" onClick={() => navigate('/transfers')} disabled={saving}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create transfer
          </button>
        </div>

        {/* Nothing has moved yet. The transfer is requested, then approved,
            then dispatched — and only dispatch takes the stock out of the
            source warehouse. */}
        <p className="text-xs text-ink-muted">
          This requests the transfer. It still needs approval and dispatch before
          any stock leaves the source warehouse.
        </p>
      </DocumentShell>
    </form>
  );
}

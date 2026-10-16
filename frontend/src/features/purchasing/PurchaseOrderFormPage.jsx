import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2, Plus, X } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import { ReferenceField, TextAreaField } from '../../components/form/fields.jsx';

/**
 * Raising a purchase order.
 *
 * A full page rather than a modal: a PO has an unbounded number of lines, and
 * a dialog that scrolls internally while the page scrolls behind it is
 * miserable to use on the laptop screens this will actually run on.
 *
 * No prices anywhere. This system holds no financial data by design — a PO
 * here is a statement of what was ordered and what is still outstanding, which
 * is what the warehouse needs. The commercial document lives wherever your
 * accounts do.
 */

const emptyLine = () => ({ product: null, orderedQuantity: null, remarks: '' });

export default function PurchaseOrderFormPage() {
  const navigate = useNavigate();

  const [header, setHeader] = useState({ vendor: null, warehouse: null, expectedDeliveryDate: '', remarks: '' });
  const [lines, setLines] = useState([emptyLine()]);
  const [products, setProducts] = useState([]);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/products', { params: { limit: 200, status: 'ACTIVE' } })
      .then((res) => setProducts(res.data.data))
      .catch(() => setProducts([]));
  }, []);

  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i) => setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((_, idx) => idx !== i)));

  const filled = useMemo(
    () => lines.filter((l) => l.product && Number(l.orderedQuantity) > 0),
    [lines],
  );

  /**
   * The same product twice on one order is almost always a mistake — two lines
   * that each look right and together order double. The server does not refuse
   * it, so this is the only place it gets caught.
   */
  const duplicates = useMemo(() => {
    const seen = new Set();
    const dupes = new Set();
    for (const line of filled) {
      if (seen.has(line.product)) dupes.add(line.product);
      seen.add(line.product);
    }
    return dupes;
  }, [filled]);

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);
    setErrors({});

    if (!header.vendor || !header.warehouse) {
      setErrors({ vendor: header.vendor ? undefined : 'Required', warehouse: header.warehouse ? undefined : 'Required' });
      setMessage('Choose a vendor and a destination warehouse.');
      return;
    }
    if (filled.length === 0) {
      setMessage('Add at least one line with a product and a quantity.');
      return;
    }
    if (duplicates.size > 0) {
      setMessage('The same product appears on more than one line. Combine them.');
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/purchase-orders', {
        vendor: header.vendor,
        warehouse: header.warehouse,
        expectedDeliveryDate: header.expectedDeliveryDate || undefined,
        remarks: header.remarks || undefined,
        lines: filled.map((l) => ({
          product: l.product,
          orderedQuantity: Number(l.orderedQuantity),
          remarks: l.remarks || undefined,
        })),
      });
      navigate(`/purchase-orders?created=${res.data.data.poNumber ?? ''}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setMessage(toMessage(err, 'Could not create the purchase order'));
      setSaving(false);
    }
  };

  const totalOrdered = filled.reduce((sum, l) => sum + Number(l.orderedQuantity || 0), 0);

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate('/purchase-orders')}
          className="rounded-md p-1.5 text-ink-muted hover:bg-paper hover:text-ink" aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold text-ink">New purchase order</h1>
          <p className="text-sm text-ink-muted">
            What you are ordering and where it should be delivered.
          </p>
        </div>
      </div>

      {message && (
        <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
        </div>
      )}

      <section className="rounded-panel border border-line bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <ReferenceField
            field={{ name: 'vendor', label: 'Vendor', endpoint: 'vendors', required: true,
              optionLabel: (r) => `${r.vendorCode} — ${r.vendorName}` }}
            value={header.vendor} error={errors.vendor}
            onChange={(v) => setHeader((h) => ({ ...h, vendor: v }))}
          />
          <ReferenceField
            field={{ name: 'warehouse', label: 'Deliver to', endpoint: 'warehouses', required: true }}
            value={header.warehouse} error={errors.warehouse}
            onChange={(v) => setHeader((h) => ({ ...h, warehouse: v }))}
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Expected delivery</span>
            <input
              type="date" value={header.expectedDeliveryDate}
              onChange={(e) => setHeader((h) => ({ ...h, expectedDeliveryDate: e.target.value }))}
              className="w-full rounded-control border border-line-strong px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="mt-4">
          <TextAreaField
            field={{ name: 'remarks', label: 'Remarks', max: 500 }}
            value={header.remarks}
            onChange={(v) => setHeader((h) => ({ ...h, remarks: v }))}
          />
        </div>
      </section>

      <section className="rounded-panel border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Lines</h2>
          <span className="text-sm text-ink-muted">
            {filled.length} line{filled.length === 1 ? '' : 's'} · {totalOrdered} units
          </span>
        </div>

        <div className="divide-y divide-line/70">
          {lines.map((line, i) => {
            const isDuplicate = line.product && duplicates.has(line.product);
            return (
              <div key={i} className={`flex flex-wrap items-end gap-3 p-4 ${isDuplicate ? 'bg-rose-50' : ''}`}>
                <div className="min-w-[16rem] flex-1">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-soft">Product</span>
                    <select
                      value={line.product ?? ''}
                      onChange={(e) => setLine(i, { product: e.target.value || null })}
                      className="w-full rounded-control border border-line-strong bg-white px-3 py-2 text-sm"
                    >
                      <option value="">—</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
                      ))}
                    </select>
                  </label>
                  {isDuplicate && (
                    <span className="mt-1 block text-xs text-rose-700">
                      Already on another line — combine them.
                    </span>
                  )}
                </div>

                <label className="block w-32">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">Quantity</span>
                  <input
                    type="number" min={1} value={line.orderedQuantity ?? ''}
                    onChange={(e) => setLine(i, { orderedQuantity: e.target.value === '' ? null : Number(e.target.value) })}
                    className="w-full rounded-control border border-line-strong px-3 py-2 text-sm"
                  />
                </label>

                <label className="block min-w-[12rem] flex-1">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">Line remarks</span>
                  <input
                    value={line.remarks ?? ''} maxLength={300}
                    onChange={(e) => setLine(i, { remarks: e.target.value })}
                    className="w-full rounded-control border border-line-strong px-3 py-2 text-sm"
                  />
                </label>

                <button type="button" onClick={() => removeLine(i)} aria-label="Remove line"
                  className="mb-1 rounded-md p-2 text-ink-muted hover:bg-paper hover:text-ink-soft">
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="border-t border-line px-4 py-3">
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])}
            className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
            <Plus className="h-4 w-4" /> Add line
          </button>
        </div>
      </section>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => navigate('/purchase-orders')} disabled={saving}
          className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Create purchase order
        </button>
      </div>

      {/* An order is raised in DRAFT and moves no stock. It has to be approved,
          and then received, before anything exists in the warehouse — which is
          why this says so rather than implying the job is done. */}
      <p className="text-xs text-ink-muted">
        This creates the order in draft. It still needs approval, and then a goods
        receipt when the delivery arrives, before any stock exists.
      </p>
    </form>
  );
}

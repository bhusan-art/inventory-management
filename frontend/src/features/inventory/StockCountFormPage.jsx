import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import DocumentShell from '../../components/documents/DocumentShell.jsx';

/**
 * Opening a stock count.
 *
 * Creating the count takes a SNAPSHOT of what the system believes is on the
 * shelf. That is the number every variance is measured against, so the moment
 * it is taken matters: counting a warehouse while goods are being received
 * into it produces variances that are really just timing.
 *
 * Scope exists because a full count of a large warehouse is a day's work.
 * Counting one category, or a named list of products, is how this actually
 * gets done — and the server requires the matching field, so the form only
 * shows the one that applies.
 */
export default function StockCountFormPage() {
  const navigate = useNavigate();

  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState({
    warehouse: null, scope: 'FULL', category: null, products: [], remarks: '',
  });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/warehouses', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/categories', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/products', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([wh, ca, pr]) => {
      setWarehouses(wh.data.data); setCategories(ca.data.data); setProducts(pr.data.data);
    });
  }, []);

  const toggleProduct = (id) => setForm((f) => ({
    ...f,
    products: f.products.includes(id) ? f.products.filter((p) => p !== id) : [...f.products, id],
  }));

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!form.warehouse) { setMessage('Choose the warehouse being counted.'); return; }
    if (form.scope === 'CATEGORY' && !form.category) {
      setMessage('Choose the category to count.');
      return;
    }
    if (form.scope === 'PRODUCT_LIST' && form.products.length === 0) {
      setMessage('Select at least one product to count.');
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/stock-counts', {
        warehouse: form.warehouse,
        scope: form.scope,
        category: form.scope === 'CATEGORY' ? form.category : undefined,
        products: form.scope === 'PRODUCT_LIST' ? form.products : undefined,
        remarks: form.remarks || undefined,
      });
      navigate(`/stock-counts/${res.data.data.id}`);
    } catch (err) {
      setMessage(toMessage(err, 'Could not open the count'));
      setSaving(false);
    }
  };

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';

  return (
    <form onSubmit={submit} noValidate>
      <DocumentShell
        backTo="/stock-counts"
        title="New stock count"
        subtitle="Compare what is on the shelf against what the system believes."
        error={message}
      >
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                Warehouse <span className="text-rose-600">*</span>
              </span>
              <select
                value={form.warehouse ?? ''} className={`${input} bg-white`}
                onChange={(e) => setForm((f) => ({ ...f, warehouse: e.target.value || null }))}
              >
                <option value="">—</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Scope</span>
              <select
                value={form.scope} className={`${input} bg-white`}
                onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
              >
                <option value="FULL">Everything in this warehouse</option>
                <option value="CATEGORY">One category</option>
                <option value="PRODUCT_LIST">A chosen list of products</option>
              </select>
            </label>

            {form.scope === 'CATEGORY' && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">
                  Category <span className="text-rose-600">*</span>
                </span>
                <select
                  value={form.category ?? ''} className={`${input} bg-white`}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value || null }))}
                >
                  <option value="">—</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </label>
            )}

            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Remarks</span>
              <input
                value={form.remarks} maxLength={500} className={input}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
              />
            </label>
          </div>

          {form.scope === 'PRODUCT_LIST' && (
            <fieldset className="mt-4 rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-medium text-ink-soft">
                Products <span className="text-rose-600">*</span> — {form.products.length} selected
              </legend>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox" checked={form.products.includes(p.id)}
                      onChange={() => toggleProduct(p.id)}
                      className="h-4 w-4 rounded border-line-strong"
                    />
                    <span className="font-mono text-xs text-ink-muted">{p.sku}</span>
                    <span className="text-ink-soft">{p.name}</span>
                  </label>
                ))}
                {products.length === 0 && <p className="text-xs text-ink-muted">No products yet.</p>}
              </div>
            </fieldset>
          )}
        </section>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button" onClick={() => navigate('/stock-counts')} disabled={saving}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Open count
          </button>
        </div>

        <p className="text-xs text-ink-muted">
          Opening the count snapshots current stock levels. Count the shelf, enter
          the figures, then complete it — completing is what applies the variances.
        </p>
      </DocumentShell>
    </form>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import DocumentShell from '../../components/documents/DocumentShell.jsx';
import LineEditor, { emptyLine, lineProblem } from '../../components/documents/LineEditor.jsx';

/**
 * A customer order.
 *
 * NO SERIALS HERE, deliberately. Units are reserved when the order is
 * confirmed, not when it is raised — asking which serials at this point would
 * promise specific units before anything has been set aside, and those units
 * could be dispatched on another order in the meantime. `requiresSerials` is
 * therefore off, and the confirm step is where custody is decided.
 *
 * No prices either: this system holds no financial data. An order here records
 * what was promised and what is still outstanding, which is what the warehouse
 * needs to pick against.
 */
export default function SalesOrderFormPage() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [header, setHeader] = useState({
    customer: null, warehouse: null, customerPoReference: '',
    requiredByDate: '', projectReference: '', remarks: '',
  });
  const [lines, setLines] = useState([emptyLine()]);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/customers', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/warehouses', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/products', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([cu, wh, pr]) => {
      setCustomers(cu.data.data); setWarehouses(wh.data.data); setProducts(pr.data.data);
    });
  }, []);

  const productsById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p])), [products],
  );

  const filled = lines.filter((l) => l.product && Number(l.quantity) > 0);

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!header.customer || !header.warehouse) {
      const missing = [!header.customer && 'a customer', !header.warehouse && 'a warehouse'].filter(Boolean);
      setMessage(`Choose ${missing.join(' and ')} before saving this order.`);
      return;
    }
    if (filled.length === 0) {
      setMessage('Add at least one line with a product and a quantity.');
      return;
    }
    if (filled.map((l) => lineProblem(l, productsById, { requiresSerials: false })).some(Boolean)) {
      setMessage('Some lines are incomplete — see the messages against them.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/sales-orders', {
        customer: header.customer,
        warehouse: header.warehouse,
        customerPoReference: header.customerPoReference || undefined,
        requiredByDate: header.requiredByDate || undefined,
        projectReference: header.projectReference || undefined,
        remarks: header.remarks || undefined,
        lines: filled.map((l) => ({
          product: l.product,
          orderedQuantity: Number(l.quantity),
          remarks: l.remarks || undefined,
        })),
      });
      navigate('/sales-orders');
    } catch (err) {
      const byField = fieldErrors(err);
      setMessage(
        Object.keys(byField).length > 0
          ? `${toMessage(err, 'Rejected')} — ${Object.entries(byField).map(([k, v]) => `${k}: ${v}`).join('; ')}`
          : toMessage(err, 'Could not create the order'),
      );
      setSaving(false);
    }
  };

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';

  return (
    <form onSubmit={submit} noValidate>
      <DocumentShell
        backTo="/sales-orders"
        title="New sales order"
        subtitle="What a customer has asked for, and which warehouse will supply it."
        error={message}
      >
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                Customer <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.customer ?? ''} className={`${input} bg-white`}
                onChange={(e) => setHeader((h) => ({ ...h, customer: e.target.value || null }))}
              >
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.customerCode} — {c.customerName}</option>
                ))}
              </select>
              {customers.length === 0 && (
                <span className="mt-1 block text-xs text-amber-700">
                  No customers yet — add one under Master data first.
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                Supply from <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.warehouse ?? ''} className={`${input} bg-white`}
                onChange={(e) => setHeader((h) => ({ ...h, warehouse: e.target.value || null }))}
              >
                <option value="">—</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Customer PO reference</span>
              <input
                value={header.customerPoReference} maxLength={60} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, customerPoReference: e.target.value }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Required by</span>
              <input
                type="date" value={header.requiredByDate} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, requiredByDate: e.target.value }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Project reference</span>
              <input
                value={header.projectReference} maxLength={120} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, projectReference: e.target.value }))}
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
              {filled.length} line{filled.length === 1 ? '' : 's'} ·{' '}
              {filled.reduce((s, l) => s + Number(l.quantity || 0), 0)} units
            </span>
          </div>

          <LineEditor
            lines={lines} setLines={setLines}
            products={products} productsById={productsById}
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
            type="button" onClick={() => navigate('/sales-orders')} disabled={saving}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create order
          </button>
        </div>

        <p className="text-xs text-ink-muted">
          Confirming the order is what reserves stock against it. Nothing is set
          aside until then, and nothing leaves until a dispatch note is raised.
        </p>
      </DocumentShell>
    </form>
  );
}

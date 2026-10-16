import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Plus } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import DocumentShell from '../../components/documents/DocumentShell.jsx';
import LineEditor, { emptyLine, lineProblem } from '../../components/documents/LineEditor.jsx';

/**
 * Sending goods out.
 *
 * Serials ARE captured here — this is the moment specific units leave the
 * building, and the server refuses a serialized line whose serial count does
 * not equal its quantity.
 *
 * A dispatch can be raised against a confirmed sales order, which prefills the
 * lines with what is still outstanding, or on its own. The direct path exists
 * because stock genuinely does leave without an order behind it — a
 * replacement under warranty, a sample, an internal issue — and a system that
 * refuses to record it just means the stock figure goes wrong instead.
 */
export default function DispatchFormPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [products, setProducts] = useState([]);
  const [orderId, setOrderId] = useState(params.get('order') ?? '');
  const [header, setHeader] = useState({
    customer: null, warehouse: null, vehicleNumber: '', transporter: '', lrNumber: '', remarks: '',
  });
  const [lines, setLines] = useState([emptyLine()]);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/sales-orders', { params: { limit: 100, status: 'CONFIRMED' } }).catch(() => ({ data: { data: [] } })),
      api.get('/customers', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/warehouses', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/products', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([so, cu, wh, pr]) => {
      setOrders(so.data.data); setCustomers(cu.data.data);
      setWarehouses(wh.data.data); setProducts(pr.data.data);
    });
  }, []);

  const productsById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p])), [products],
  );

  // Picking an order replaces the lines with what it still owes.
  useEffect(() => {
    if (!orderId) return;
    api.get(`/sales-orders/${orderId}`)
      .then((res) => {
        const order = res.data.data;
        setHeader((h) => ({
          ...h, customer: order.customer?.id ?? null, warehouse: order.warehouse?.id ?? null,
        }));
        setLines(
          order.lines
            .filter((l) => l.outstandingQuantity > 0)
            .map((l) => ({
              ...emptyLine(),
              key: l.id,
              product: l.product?.id ?? null,
              quantity: l.outstandingQuantity,
              salesOrderLineId: l.id,
              // Confirming the order already chose the units. Prefilling them
              // means the picker scans to verify rather than to decide.
              serialNumbers: [...(l.reservedSerialNumbers ?? [])].slice(0, l.outstandingQuantity),
            })),
        );
      })
      .catch((err) => setMessage(toMessage(err, 'Could not load that order')));
  }, [orderId]);

  const filled = lines.filter((l) => l.product && Number(l.quantity) > 0);

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    if (!header.customer || !header.warehouse) {
      const missing = [!header.customer && 'a customer', !header.warehouse && 'a warehouse'].filter(Boolean);
      setMessage(`Choose ${missing.join(' and ')} before saving this dispatch.`);
      return;
    }
    if (filled.length === 0) {
      setMessage('Add at least one line with a product and a quantity.');
      return;
    }
    if (filled.map((l) => lineProblem(l, productsById, { requiresSerials: true })).some(Boolean)) {
      setMessage('Some lines are incomplete — see the messages against them.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/dispatch-notes', {
        customer: header.customer,
        warehouse: header.warehouse,
        salesOrder: orderId || undefined,
        vehicleNumber: header.vehicleNumber || undefined,
        transporter: header.transporter || undefined,
        lrNumber: header.lrNumber || undefined,
        remarks: header.remarks || undefined,
        lines: filled.map((l) => ({
          product: l.product,
          salesOrderLineId: l.salesOrderLineId || undefined,
          quantity: Number(l.quantity),
          serialNumbers: productsById[l.product]?.productType === 'SERIALIZED' ? l.serialNumbers : [],
          remarks: l.remarks || undefined,
        })),
      });
      navigate('/dispatch-notes');
    } catch (err) {
      const byField = fieldErrors(err);
      setMessage(
        Object.keys(byField).length > 0
          ? `${toMessage(err, 'Rejected')} — ${Object.entries(byField).map(([k, v]) => `${k}: ${v}`).join('; ')}`
          : toMessage(err, 'Could not create the dispatch note'),
      );
      setSaving(false);
    }
  };

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';
  const locked = Boolean(orderId);

  return (
    <form onSubmit={submit} noValidate>
      <DocumentShell
        backTo="/dispatch-notes"
        title="New dispatch note"
        subtitle="What is leaving the warehouse, and who it is going to."
        error={message}
      >
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Against sales order</span>
              <select
                value={orderId} className={`${input} bg-white`}
                onChange={(e) => setOrderId(e.target.value)}
              >
                <option value="">No order — direct dispatch</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.salesOrderNumber} — {o.customer?.name ?? ''} ({o.totals?.outstanding ?? 0} outstanding)
                  </option>
                ))}
              </select>
              {orders.length === 0 && (
                <span className="mt-1 block text-xs text-amber-700">
                  No confirmed orders. Confirm one, or dispatch directly.
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                Customer <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.customer ?? ''} disabled={locked}
                className={`${input} bg-white disabled:bg-paper`}
                onChange={(e) => setHeader((h) => ({ ...h, customer: e.target.value || null }))}
              >
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.customerCode} — {c.customerName}</option>
                ))}
              </select>
              {locked && <span className="mt-1 block text-xs text-ink-muted">Taken from the order.</span>}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">
                Dispatch from <span className="text-rose-600">*</span>
              </span>
              <select
                value={header.warehouse ?? ''} disabled={locked}
                className={`${input} bg-white disabled:bg-paper`}
                onChange={(e) => setHeader((h) => ({ ...h, warehouse: e.target.value || null }))}
              >
                <option value="">—</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              {locked && <span className="mt-1 block text-xs text-ink-muted">Taken from the order.</span>}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Vehicle number</span>
              <input
                value={header.vehicleNumber} maxLength={20} className={`${input} font-mono`}
                onChange={(e) => setHeader((h) => ({ ...h, vehicleNumber: e.target.value.toUpperCase() }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Transporter</span>
              <input
                value={header.transporter} maxLength={120} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, transporter: e.target.value }))}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">LR number</span>
              <input
                value={header.lrNumber} maxLength={60} className={input}
                onChange={(e) => setHeader((h) => ({ ...h, lrNumber: e.target.value }))}
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
            type="button" onClick={() => navigate('/dispatch-notes')} disabled={saving}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit" disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Create dispatch note
          </button>
        </div>

        <p className="text-xs text-ink-muted">
          Creating the note takes the stock out of the warehouse. Marking it
          delivered later records who signed for it.
        </p>
      </DocumentShell>
    </form>
  );
}

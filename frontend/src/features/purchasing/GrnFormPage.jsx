import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2, ScanLine, X } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';

/**
 * Receiving goods.
 *
 * This is where stock actually comes into existence, and the screen is built
 * around the three facts that make a receipt go wrong in practice.
 *
 * 1. WHAT ARRIVED IS NOT WHAT WAS ORDERED. Lines prefill from the order's
 *    outstanding quantity because that is usually right, but every number
 *    stays editable. A screen that assumes the delivery matches the paperwork
 *    forces the receiver to lie to it.
 *
 * 2. ACCEPTED + DAMAGED + REJECTED MUST EQUAL RECEIVED. The server refuses
 *    otherwise, and discovering that after typing forty lines is miserable —
 *    so the split is computed and shown per line as it is typed.
 *
 * 3. A SERIALIZED PRODUCT NEEDS ONE SERIAL PER ACCEPTED UNIT. Not approximately
 *    — exactly. The count is shown against the requirement, duplicates are
 *    caught here rather than by a unique-index violation on submit, and the
 *    input takes a barcode scanner's Enter key as "next serial".
 *
 * Creating a GRN does not move stock. Posting it does. That separation exists
 * so a receipt can be checked before it becomes inventory, and the page says
 * so rather than quietly doing both.
 */

const blank = (product) => ({
  product: product?.id ?? null,
  productType: product?.productType ?? 'NON_SERIALIZED',
  label: product ? `${product.sku ?? product.code ?? ''} — ${product.name}` : '',
  receivedQuantity: null,
  damagedQuantity: 0,
  rejectedQuantity: 0,
  shortQuantity: 0,
  rackLocation: '',
  batchNumber: '',
  serialNumbers: [],
  serialDraft: '',
});

export default function GrnFormPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const canPost = usePermission('POST_GRN');

  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [poId, setPoId] = useState(params.get('po') ?? '');
  const [header, setHeader] = useState({
    vendor: null, warehouse: null, vendorInvoiceNumber: '', vendorChallanNumber: '', remarks: '',
  });
  const [lines, setLines] = useState([]);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [postAfter, setPostAfter] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/purchase-orders', { params: { limit: 100, status: 'APPROVED' } }).catch(() => ({ data: { data: [] } })),
      api.get('/products', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/warehouses', { params: { limit: 100, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
      api.get('/vendors', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([po, pr, wh, vn]) => {
      setOrders(po.data.data);
      setProducts(pr.data.data);
      setWarehouses(wh.data.data);
      setVendors(vn.data.data);
    });
  }, []);

  const productById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p])),
    [products],
  );

  // Loading an order replaces the lines with its outstanding ones.
  useEffect(() => {
    if (!poId) return;
    api.get(`/purchase-orders/${poId}`)
      .then((res) => {
        const po = res.data.data;
        setHeader((h) => ({ ...h, vendor: po.vendor?.id ?? null, warehouse: po.warehouse?.id ?? null }));
        setLines(
          po.lines
            .filter((l) => l.outstandingQuantity > 0)
            .map((l) => {
              const product = productById[l.product?.id] ?? l.product;
              return {
                ...blank({ ...product, id: l.product?.id, name: l.product?.name, code: l.product?.code }),
                productType: productById[l.product?.id]?.productType ?? 'NON_SERIALIZED',
                receivedQuantity: l.outstandingQuantity,
              };
            }),
        );
      })
      .catch((err) => setMessage(toMessage(err, 'Could not load that order')));
  }, [poId, productById]);

  const setLine = (i, patch) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addSerial = (i, raw) => {
    const serial = String(raw ?? '').trim().toUpperCase();
    if (!serial) return;
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      // Caught here rather than by a unique-index violation after submit,
      // which would reject the whole receipt over one mis-scan.
      if (l.serialNumbers.includes(serial)) {
        return { ...l, serialDraft: '', serialError: `${serial} already scanned on this line` };
      }
      return { ...l, serialNumbers: [...l.serialNumbers, serial], serialDraft: '', serialError: null };
    }));
  };

  const accepted = (l) => Math.max(
    0,
    Number(l.receivedQuantity || 0) - Number(l.damagedQuantity || 0) - Number(l.rejectedQuantity || 0),
  );

  const lineProblem = (l) => {
    const received = Number(l.receivedQuantity || 0);
    if (received === 0 && Number(l.shortQuantity || 0) === 0) return 'Record a quantity or a shortage';
    if (Number(l.damagedQuantity || 0) + Number(l.rejectedQuantity || 0) > received) {
      return 'Damaged plus rejected is more than was received';
    }
    if (l.productType === 'SERIALIZED' && l.serialNumbers.length !== accepted(l)) {
      return `${l.serialNumbers.length} of ${accepted(l)} serials captured`;
    }
    return null;
  };

  const problems = lines.map(lineProblem);

  /** `lines.0.receivedQuantity` → `serverLineErrors[0].receivedQuantity`. */
  const serverLineErrors = useMemo(() => {
    const byLine = {};
    for (const [path, text] of Object.entries(errors)) {
      const match = path.match(/^lines\.(\d+)\.(.+)$/);
      if (!match) continue;
      byLine[Number(match[1])] ??= {};
      byLine[Number(match[1])][match[2]] = text;
    }
    return byLine;
  }, [errors]);
  const usable = lines.filter((l, i) => !problems[i]);

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);
    setErrors({});

    // Name what is actually missing. "needs a vendor and a warehouse" when the
    // warehouse is already filled in sends the reader looking at the wrong field.
    if (!header.vendor || !header.warehouse) {
      const missing = [!header.vendor && 'a vendor', !header.warehouse && 'a warehouse'].filter(Boolean);
      setMessage(`Choose ${missing.join(' and ')} before saving this receipt.`);
      return;
    }
    if (lines.length === 0) {
      setMessage('Add at least one line.');
      return;
    }
    if (usable.length !== lines.length) {
      setMessage('Some lines are incomplete — see the messages against them.');
      return;
    }

    setSaving(true);
    try {
      const res = await api.post('/grn', {
        vendor: header.vendor,
        purchaseOrder: poId || undefined,
        warehouse: header.warehouse,
        vendorInvoiceNumber: header.vendorInvoiceNumber || undefined,
        vendorChallanNumber: header.vendorChallanNumber || undefined,
        remarks: header.remarks || undefined,
        lines: lines.map((l) => ({
          product: l.product,
          receivedQuantity: Number(l.receivedQuantity || 0),
          acceptedQuantity: accepted(l),
          damagedQuantity: Number(l.damagedQuantity || 0),
          rejectedQuantity: Number(l.rejectedQuantity || 0),
          shortQuantity: Number(l.shortQuantity || 0),
          rackLocation: l.rackLocation || undefined,
          batchNumber: l.batchNumber || undefined,
          serialNumbers: l.productType === 'SERIALIZED' ? l.serialNumbers : [],
        })),
      });

      // Posting is what moves stock. If it fails the GRN still exists, so the
      // message says where to find it rather than implying nothing happened.
      if (postAfter && canPost) {
        try {
          await api.post(`/grn/${res.data.data.id}/post`, {});
        } catch (err) {
          setMessage(
            `${res.data.data.grnNumber} was created but could not be posted: `
            + `${toMessage(err, 'unknown error')}. Open it from Goods Received to post it.`,
          );
          setSaving(false);
          return;
        }
      }
      navigate('/grn');
    } catch (err) {
      setErrors(fieldErrors(err));
      setMessage(toMessage(err, 'Could not create the receipt'));
      setSaving(false);
    }
  };

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';
  const small = 'w-24 rounded-control border border-line-strong px-2 py-2 text-sm';

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => navigate('/grn')} aria-label="Back"
          className="rounded-md p-1.5 text-ink-muted hover:bg-paper hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-lg font-semibold text-ink">Receive goods</h1>
          <p className="text-sm text-ink-muted">What actually turned up, which may not be what was ordered.</p>
        </div>
      </div>

      {message && (
        <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
        </div>
      )}

      <section className="rounded-panel border border-line bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Against purchase order</span>
            <select value={poId} onChange={(e) => setPoId(e.target.value)} className={`${input} bg-white`}>
              <option value="">No order — direct receipt</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.poNumber} — {o.vendor?.name ?? ''} ({o.totals?.outstanding ?? 0} outstanding)
                </option>
              ))}
            </select>
            {orders.length === 0 && (
              <span className="mt-1 block text-xs text-amber-700">
                No approved orders. Raise one and approve it, or receive directly.
              </span>
            )}
          </label>

          {/*
            A receipt without a vendor is a receipt from nobody, so the server
            requires one. The first version of this screen only ever set the
            vendor FROM the purchase order — which meant a direct receipt could
            never satisfy a validation message that asked for something the
            form did not offer. A dead end, and the user's only clue was being
            told to supply a field that was not on screen.
          */}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">
              Vendor <span className="text-rose-600">*</span>
            </span>
            <select
              value={header.vendor ?? ''} disabled={Boolean(poId)}
              onChange={(e) => setHeader((h) => ({ ...h, vendor: e.target.value || null }))}
              className={`${input} bg-white disabled:bg-paper`}
            >
              <option value="">—</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.vendorCode} — {v.vendorName}</option>
              ))}
            </select>
            {poId
              ? <span className="mt-1 block text-xs text-ink-muted">Taken from the order.</span>
              : vendors.length === 0 && (
                <span className="mt-1 block text-xs text-amber-700">
                  No vendors yet — add one under Master data first.
                </span>
              )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">
              Warehouse <span className="text-rose-600">*</span>
            </span>
            <select
              value={header.warehouse ?? ''} disabled={Boolean(poId)}
              onChange={(e) => setHeader((h) => ({ ...h, warehouse: e.target.value || null }))}
              className={`${input} bg-white disabled:bg-paper`}
            >
              <option value="">—</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
            {poId && <span className="mt-1 block text-xs text-ink-muted">Taken from the order.</span>}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Vendor invoice number</span>
            <input value={header.vendorInvoiceNumber} maxLength={60} className={input}
              onChange={(e) => setHeader((h) => ({ ...h, vendorInvoiceNumber: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">Challan number</span>
            <input value={header.vendorChallanNumber} maxLength={60} className={input}
              onChange={(e) => setHeader((h) => ({ ...h, vendorChallanNumber: e.target.value }))} />
          </label>
        </div>
      </section>

      <section className="rounded-panel border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Lines</h2>
          {!poId && (
            <select
              value="" className="rounded-control border border-line-strong px-2 py-1.5 text-sm"
              onChange={(e) => {
                const product = productById[e.target.value];
                if (product) setLines((ls) => [...ls, blank(product)]);
              }}
            >
              <option value="">Add a product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
            </select>
          )}
        </div>

        {lines.length === 0 && (
          <p className="p-6 text-sm text-ink-muted">
            {poId ? 'Nothing outstanding on that order.' : 'Add the products that arrived.'}
          </p>
        )}

        <div className="divide-y divide-line/70">
          {lines.map((line, i) => (
            <div key={i} className="space-y-3 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[14rem] flex-1">
                  <span className="block text-sm font-medium text-ink">{line.label}</span>
                  {line.productType === 'SERIALIZED' && (
                    <span className="text-xs text-ink-muted">Serialized — one serial per accepted unit</span>
                  )}
                </div>

                {[['receivedQuantity', 'Received'], ['damagedQuantity', 'Damaged'],
                  ['rejectedQuantity', 'Rejected'], ['shortQuantity', 'Short']].map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
                      <input
                        type="number" min={0} value={line[key] ?? ''} className={small}
                        onChange={(e) => setLine(i, { [key]: e.target.value === '' ? 0 : Number(e.target.value) })}
                      />
                    </label>
                ))}

                <div className="mb-2">
                  <span className="block text-xs font-medium text-ink-soft">Accepted</span>
                  <span className="text-sm font-semibold text-ink">{accepted(line)}</span>
                </div>

                <button type="button" aria-label="Remove line"
                  onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                  className="mb-1 rounded-md p-2 text-ink-muted hover:bg-paper hover:text-ink-soft">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex flex-wrap gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">Rack</span>
                  <input value={line.rackLocation} maxLength={40} className={`${small} w-32 font-mono`}
                    onChange={(e) => setLine(i, { rackLocation: e.target.value.toUpperCase() })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-soft">Batch</span>
                  <input value={line.batchNumber} maxLength={60} className={`${small} w-40`}
                    onChange={(e) => setLine(i, { batchNumber: e.target.value })} />
                </label>
              </div>

              {line.productType === 'SERIALIZED' && (
                <div className="rounded-md border border-line bg-paper p-3">
                  <div className="flex items-center gap-2">
                    <ScanLine className="h-4 w-4 text-ink-muted" />
                    <input
                      value={line.serialDraft} placeholder="Scan or type a serial, then Enter"
                      className="flex-1 rounded-control border border-line-strong px-3 py-2 font-mono text-sm"
                      onChange={(e) => setLine(i, { serialDraft: e.target.value })}
                      onKeyDown={(e) => {
                        // A barcode scanner sends the serial then Enter. Letting
                        // that submit the form would post a half-filled receipt.
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        addSerial(i, line.serialDraft);
                      }}
                    />
                    <span className={`text-sm ${
                      line.serialNumbers.length === accepted(line) ? 'text-emerald-700' : 'text-ink-muted'
                    }`}
                    >
                      {line.serialNumbers.length} / {accepted(line)}
                    </span>
                  </div>

                  {line.serialError && (
                    <p className="mt-2 text-xs text-rose-700">{line.serialError}</p>
                  )}

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

              {problems[i] && (
                <p className="text-xs text-amber-700">{problems[i]}</p>
              )}

              {/* The server validates lines positionally, so its errors arrive
                  as `lines.0.receivedQuantity`. Showing them against the line
                  they belong to is the difference between "Validation failed"
                  and knowing which of forty lines to look at. */}
              {Object.entries(serverLineErrors[i] ?? {}).map(([field, text]) => (
                <p key={field} className="text-xs text-rose-700">{field}: {text}</p>
              ))}
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {canPost ? (
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={postAfter} onChange={(e) => setPostAfter(e.target.checked)}
              className="h-4 w-4 rounded border-line-strong" />
            Post immediately — this is what moves the stock into the warehouse
          </label>
        ) : (
          <p className="text-sm text-ink-muted">
            You can record this receipt, but posting it needs the POST_GRN permission.
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={() => navigate('/grn')} disabled={saving}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={saving || lines.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {postAfter && canPost ? 'Receive and post' : 'Save receipt'}
          </button>
        </div>
      </div>
    </form>
  );
}

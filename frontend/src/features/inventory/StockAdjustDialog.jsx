import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import { ReferenceField, SelectField, NumberField, TextAreaField } from '../../components/form/fields.jsx';

/**
 * Adjusting stock.
 *
 * The single most important thing about this screen: `newQuantity` is an
 * ABSOLUTE level, not a change. The API sets stock to the number given. A box
 * labelled "Quantity" next to an existing figure of 1,200 reads as "add this
 * much" to most people, and typing 50 would silently destroy 1,150 units of
 * recorded stock.
 *
 * So the dialog shows the current level, offers "add / remove / set exactly"
 * explicitly, and renders the resulting figure before the user commits. The
 * arithmetic happens here and the absolute number goes to the API, which keeps
 * the server's contract unchanged and the user's intent visible.
 *
 * A reason is mandatory because an adjustment is the one way stock changes
 * without a document behind it. "Where did 400 metres go" has to have an
 * answer, and `PHYSICAL_COUNT` versus `THEFT` are very different answers.
 */

const REASONS = [
  { value: 'PHYSICAL_COUNT', label: 'Physical count — the shelf disagreed with the system' },
  { value: 'FOUND_STOCK', label: 'Found stock — units that were never recorded' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'THEFT', label: 'Theft or loss' },
  { value: 'EXPIRY', label: 'Expiry' },
  { value: 'DATA_CORRECTION', label: 'Data correction — a previous entry was wrong' },
];

const BUCKETS = [
  { value: 'AVAILABLE', label: 'Available' },
  { value: 'QUARANTINED', label: 'Quarantined' },
  { value: 'DAMAGED', label: 'Damaged' },
];

const MODES = [
  { value: 'ADD', label: 'Add to stock' },
  { value: 'REMOVE', label: 'Remove from stock' },
  { value: 'SET', label: 'Set exact level' },
];

export default function StockAdjustDialog({ row, onClose, onDone }) {
  const [form, setForm] = useState({
    product: row?.product?.id ?? null,
    warehouse: row?.warehouse?.id ?? null,
    bucket: 'AVAILABLE',
    mode: 'ADD',
    amount: null,
    reasonCode: 'FOUND_STOCK',
    remarks: '',
  });
  const [current, setCurrent] = useState(row ? Number(row.available ?? 0) : null);
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  // Escape closes, as it does in every other dialog here. It was missing, and
  // a modal that ignores Escape when its neighbours honour it is the kind of
  // inconsistency people blame on themselves.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  /**
   * Re-read the current level whenever product, warehouse or bucket changes.
   *
   * Without this the preview would be computed against a stale figure, and the
   * preview is the only thing standing between the user and an absolute
   * quantity they did not intend.
   */
  useEffect(() => {
    if (!form.product || !form.warehouse) { setCurrent(null); return undefined; }
    let cancelled = false;
    setCurrent(null);

    api.get('/inventory', { params: { product: form.product, warehouse: form.warehouse, limit: 1 } })
      .then((res) => {
        if (cancelled) return;
        const found = res.data.data?.[0];
        const byBucket = {
          AVAILABLE: found?.available, QUARANTINED: found?.quarantined, DAMAGED: found?.damaged,
        };
        setCurrent(Number(byBucket[form.bucket] ?? 0));
      })
      .catch(() => !cancelled && setCurrent(0));

    return () => { cancelled = true; };
  }, [form.product, form.warehouse, form.bucket]);

  const amount = Number(form.amount ?? 0);
  const resulting = current === null ? null
    : form.mode === 'SET' ? amount
      : form.mode === 'ADD' ? current + amount
        : current - amount;

  const wouldGoNegative = resulting !== null && resulting < 0;

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    const missing = {};
    if (!form.product) missing.product = 'Required';
    if (!form.warehouse) missing.warehouse = 'Required';
    if (!(amount > 0)) missing.amount = 'Enter a quantity';
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setMessage('Fill in the highlighted fields.');
      return;
    }

    if (wouldGoNegative) {
      setMessage('That would take stock below zero. Check the quantity.');
      return;
    }

    setSaving(true);
    try {
      await api.post('/inventory/adjust', {
        product: form.product,
        warehouse: form.warehouse,
        bucket: form.bucket,
        // Absolute, computed from the mode the user chose.
        newQuantity: resulting,
        reasonCode: form.reasonCode,
        remarks: form.remarks || undefined,
      });
      onDone();
    } catch (err) {
      const byField = fieldErrors(err);
      setErrors(byField);
      setMessage(toMessage(err, 'Could not adjust stock'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">Adjust stock</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-md p-1 text-ink-muted hover:bg-paper hover:text-ink-soft">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          <div className="space-y-4 px-5 py-4">
            {message && (
              <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <ReferenceField
                field={{ name: 'product', label: 'Product', endpoint: 'products', required: true,
                  optionLabel: (r) => `${r.sku} — ${r.name}` }}
                value={form.product} error={errors.product}
                onChange={(v) => set('product', v)}
              />
              <ReferenceField
                field={{ name: 'warehouse', label: 'Warehouse', endpoint: 'warehouses', required: true }}
                value={form.warehouse} error={errors.warehouse}
                onChange={(v) => set('warehouse', v)}
              />
              <SelectField
                field={{ name: 'bucket', label: 'Bucket', required: true, options: BUCKETS,
                  help: 'Damaged and quarantined stock is held separately and cannot be sold.' }}
                value={form.bucket} onChange={(v) => set('bucket', v)}
              />
              <SelectField
                field={{ name: 'mode', label: 'Change', required: true, options: MODES }}
                value={form.mode} onChange={(v) => set('mode', v)}
              />
              <NumberField
                field={{ name: 'amount', label: form.mode === 'SET' ? 'New level' : 'Quantity', required: true, min: 0 }}
                value={form.amount} error={errors.amount}
                onChange={(v) => set('amount', v)}
              />
              <SelectField
                field={{ name: 'reasonCode', label: 'Reason', required: true, options: REASONS }}
                value={form.reasonCode} onChange={(v) => set('reasonCode', v)}
              />
            </div>

            {/* The preview. This is the control that stops an absolute
                quantity being mistaken for a delta. */}
            <div className={`rounded-md border p-3 text-sm ${
              wouldGoNegative ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-paper'
            }`}
            >
              {form.product && form.warehouse ? (
                current === null ? (
                  <span className="text-ink-muted">Reading current level…</span>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-ink-soft">
                      Current <strong className="font-semibold text-ink">{current}</strong>
                    </span>
                    <span aria-hidden className="text-ink-muted">→</span>
                    <span className={wouldGoNegative ? 'text-rose-800' : 'text-ink-soft'}>
                      After this adjustment{' '}
                      <strong className="font-semibold">{resulting}</strong>
                    </span>
                  </div>
                )
              ) : (
                <span className="text-ink-muted">Choose a product and warehouse.</span>
              )}
              {wouldGoNegative && (
                <p className="mt-2 text-xs text-rose-800">
                  Stock cannot go below zero. The server would refuse this.
                </p>
              )}
            </div>

            <TextAreaField
              field={{ name: 'remarks', label: 'Remarks', max: 500,
                help: 'Why the figure changed. This is what an auditor reads.' }}
              value={form.remarks} onChange={(v) => set('remarks', v)}
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button type="button" onClick={onClose} disabled={saving}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={saving || wouldGoNegative}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Adjust stock
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

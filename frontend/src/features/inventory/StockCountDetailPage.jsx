import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Save, XCircle } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import DocumentShell, { Totals } from '../../components/documents/DocumentShell.jsx';

/**
 * Entering a count and applying it.
 *
 * The system quantity is deliberately shown. There is an argument for a blind
 * count — hiding it stops the counter talking themselves into the expected
 * number — but this is a small team counting their own shelves, and hiding the
 * figure mostly produces typos nobody catches. Shown, a variance is obvious
 * immediately and gets recounted on the spot.
 *
 * Saving counts and completing the count are separate. Saving is a scratchpad
 * you can come back to; completing writes every variance into the ledger as an
 * adjustment and cannot be undone.
 */
export default function StockCountDetailPage() {
  const { id } = useParams();

  const canRecord = usePermission('ADJUST_INVENTORY');
  const canComplete = usePermission('ADJUST_INVENTORY_UNLIMITED');

  const [count, setCount] = useState(null);
  const [entries, setEntries] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    api.get(`/stock-counts/${id}`)
      .then((res) => {
        setCount(res.data.data);
        setEntries({});
        setError(null);
      })
      .catch((err) => setError(toMessage(err, 'Could not load that count')));
  }, [id]);

  useEffect(load, [load]);

  // Only lines the user actually touched are sent. Submitting every line would
  // mark untouched ones as counted at their system quantity, which silently
  // turns "not yet counted" into "counted and correct".
  const pending = useMemo(() => Object.entries(entries)
    .filter(([, v]) => v !== '' && v != null)
    .map(([lineId, v]) => ({ lineId, countedQuantity: Number(v) })), [entries]);

  const save = async () => {
    if (pending.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/stock-counts/${id}/counts`, { entries: pending });
      load();
    } catch (err) {
      setError(toMessage(err, 'Could not save those counts'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !count) return <p className="text-sm text-rose-700">{error}</p>;
  if (!count) return <p className="text-sm text-ink-muted">Loading…</p>;

  const open = !['COMPLETED', 'CANCELLED'].includes(count.status);
  const allCounted = count.progress.counted === count.progress.total;

  return (
    <DocumentShell
      backTo="/stock-counts"
      title={count.countNumber}
      mono
      status={count.status}
      subtitle={`${count.warehouse?.name ?? '—'} · ${String(count.scope).toLowerCase().replace('_', ' ')} count`}
      error={error}
      actions={open && (
        <>
          {canRecord && pending.length > 0 && (
            <button
              type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save {pending.length} count{pending.length === 1 ? '' : 's'}
            </button>
          )}
          {canComplete && (
            <button
              type="button" onClick={() => setCompleting(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-60"
            >
              <CheckCircle2 className="h-4 w-4" /> Complete count
            </button>
          )}
          {canRecord && (
            <button
              type="button" onClick={() => setCancelling(true)}
              className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper"
            >
              <XCircle className="h-4 w-4" /> Cancel
            </button>
          )}
        </>
      )}
    >
      {open && !canComplete && (
        <p className="rounded-md bg-paper p-3 text-sm text-ink-soft">
          You can enter counts, but applying them needs the unlimited-adjustment
          permission. Completing a count can move stock by any amount, which is
          why it is held separately.
        </p>
      )}

      <Totals items={[
        ['Lines', count.progress.total],
        ['Counted', count.progress.counted],
        ['Variances', count.progress.variances],
        ['Snapshot taken', count.snapshotAt ? new Date(count.snapshotAt).toLocaleString() : '—'],
      ]}
      />

      <section className="overflow-hidden rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper text-left text-xs font-medium text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              <th className="px-4 py-2.5 font-medium">System</th>
              <th className="px-4 py-2.5 font-medium">Counted</th>
              <th className="px-4 py-2.5 font-medium">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {count.lines.map((line) => {
              const draft = entries[line.id];
              const shown = draft !== undefined && draft !== ''
                ? Number(draft)
                : line.counted ? line.countedQuantity : null;
              const variance = shown === null ? null : shown - line.systemQuantity;

              return (
                <tr key={line.id} className={line.counted && line.variance !== 0 ? 'bg-amber-50/50' : ''}>
                  <td className="px-4 py-2.5 text-ink">
                    <span className="font-mono text-xs text-ink-muted">{line.product?.sku ?? ''}</span>{' '}
                    {line.product?.name ?? '—'}
                    {line.product?.uom && <span className="ml-1 text-xs text-ink-muted">({line.product.uom})</span>}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">{line.systemQuantity}</td>
                  <td className="px-4 py-2.5">
                    {open && canRecord ? (
                      <input
                        type="number" min={0}
                        value={draft ?? (line.counted ? line.countedQuantity : '')}
                        onChange={(e) => setEntries((x) => ({ ...x, [line.id]: e.target.value }))}
                        className="w-28 rounded-control border border-line-strong px-2 py-1.5 text-sm"
                      />
                    ) : (
                      <span>{line.counted ? line.countedQuantity : '—'}</span>
                    )}
                  </td>
                  <td className={`px-4 py-2.5 font-medium ${
                    variance === null ? 'text-ink-muted'
                      : variance === 0 ? 'text-ink-muted'
                        : variance > 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                  >
                    {variance === null ? '—' : variance > 0 ? `+${variance}` : variance}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {completing && (
        <ConfirmDialog
          title="Complete this count?"
          body={
            allCounted
              ? `Every variance is written into the stock ledger as an adjustment. ${count.progress.variances} line(s) will change. This cannot be undone.`
              : `Only ${count.progress.counted} of ${count.progress.total} lines have been counted. Uncounted lines are left alone — but a line counted by mistake at the wrong figure is applied like any other. This cannot be undone.`
          }
          confirmLabel="Complete count"
          method="post"
          endpoint={`/stock-counts/${count.id}/complete`}
          onClose={() => setCompleting(false)}
          onDone={() => { setCompleting(false); load(); }}
        />
      )}

      {cancelling && (
        <ConfirmDialog
          title="Cancel this count?"
          body="The figures entered are discarded and no stock changes."
          confirmLabel="Cancel count"
          destructive
          method="post"
          endpoint={`/stock-counts/${count.id}/cancel`}
          reasonField="Why is this being cancelled?"
          onClose={() => setCancelling(false)}
          onDone={() => { setCancelling(false); load(); }}
        />
      )}
    </DocumentShell>
  );
}

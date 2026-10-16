import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, PackageCheck, XCircle } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import DocumentShell, { Totals } from '../../components/documents/DocumentShell.jsx';

/**
 * A dispatch note, and the only thing left to do with it: record delivery.
 *
 * The stock left the warehouse when the note was created. Marking it delivered
 * records WHO SIGNED FOR IT, which is the difference between "we sent it" and
 * "they got it" — and that distinction is the whole substance of a delivery
 * dispute.
 *
 * Cancelling returns the units to stock, which is correct for a load that
 * never actually left, and wrong for one that did. The confirmation says so,
 * because the system cannot tell the difference and the person can.
 */
export default function DispatchDetailPage() {
  const { id } = useParams();

  const canDeliver = usePermission('CREATE_DISPATCH');
  const canCancel = usePermission('CANCEL_DISPATCH');

  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [delivery, setDelivery] = useState(null);

  const load = useCallback(() => {
    api.get(`/dispatch-notes/${id}`)
      .then((res) => { setNote(res.data.data); setError(null); })
      .catch((err) => setError(toMessage(err, 'Could not load that dispatch note')));
  }, [id]);

  useEffect(load, [load]);

  const markDelivered = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/dispatch-notes/${id}/deliver`, {
        deliveredDate: delivery.date || undefined,
        receivedByName: delivery.receivedByName || undefined,
      });
      setDelivery(null);
      load();
    } catch (err) {
      setError(toMessage(err, 'Could not record the delivery'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !note) return <p className="text-sm text-rose-700">{error}</p>;
  if (!note) return <p className="text-sm text-ink-muted">Loading…</p>;

  const input = 'w-full rounded-control border border-line-strong px-3 py-2 text-sm';

  return (
    <DocumentShell
      backTo="/dispatch-notes"
      title={note.dispatchNoteNumber}
      mono
      status={note.status}
      subtitle={[
        note.customer?.name,
        note.salesOrder?.salesOrderNumber && `against ${note.salesOrder.salesOrderNumber}`,
        note.vehicleNumber,
      ].filter(Boolean).join(' · ')}
      error={error}
      actions={(
        <>
          {note.status === 'DISPATCHED' && canDeliver && !delivery && (
            <button
              type="button"
              onClick={() => setDelivery({ date: new Date().toISOString().slice(0, 10), receivedByName: '' })}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
            >
              <PackageCheck className="h-4 w-4" /> Mark delivered
            </button>
          )}
          {note.status === 'DISPATCHED' && canCancel && (
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
      {delivery && (
        <section className="rounded-lg border border-line-strong bg-white p-4">
          <h2 className="text-sm font-semibold text-ink">Record the delivery</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Delivered on</span>
              <input
                type="date" value={delivery.date} className={input}
                onChange={(e) => setDelivery((d) => ({ ...d, date: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink-soft">Received by</span>
              <input
                value={delivery.receivedByName} maxLength={120} className={input}
                placeholder="Name of the person who signed"
                onChange={(e) => setDelivery((d) => ({ ...d, receivedByName: e.target.value }))}
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button" onClick={() => setDelivery(null)} disabled={busy}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper"
            >
              Cancel
            </button>
            <button
              type="button" onClick={markDelivered} disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm delivery
            </button>
          </div>
        </section>
      )}

      <Totals items={[
        ['Units', note.totals.units],
        ['Serialized units', note.totals.serials],
        ['Delivered on', note.deliveredDate ? new Date(note.deliveredDate).toLocaleDateString() : '—'],
        ['Received by', note.receivedByName ?? '—'],
      ]}
      />

      <section className="overflow-hidden rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper text-left text-xs font-medium text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              <th className="px-4 py-2.5 font-medium">Quantity</th>
              <th className="px-4 py-2.5 font-medium">Serial numbers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {note.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-4 py-2.5 text-ink">
                  <span className="font-mono text-xs text-ink-muted">{line.product?.code ?? ''}</span>{' '}
                  {line.product?.name ?? '—'}
                </td>
                <td className="px-4 py-2.5">{line.quantity}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">
                  {line.serialNumbers.length > 0 ? line.serialNumbers.join(', ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this dispatch?"
          body="The units go back into stock. Only do this for a load that did not actually leave — if it did, the goods are gone and a customer return is the honest record."
          confirmLabel="Cancel dispatch"
          destructive
          method="post"
          endpoint={`/dispatch-notes/${note.id}/cancel`}
          reasonField="Why is this being cancelled?"
          onClose={() => setCancelling(false)}
          onDone={() => { setCancelling(false); load(); }}
        />
      )}
    </DocumentShell>
  );
}

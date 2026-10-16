import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Loader2, PackageCheck, Send, XCircle } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import DocumentShell, { Totals } from '../../components/documents/DocumentShell.jsx';

/**
 * A transfer, and its four moments: approved, dispatched, received, or cancelled.
 *
 * Dispatch is the one that empties the source warehouse; receive is the one
 * that fills the destination. Between them the stock is in transit and belongs
 * to neither — which is why the receiving step asks what actually arrived and
 * what was damaged on the way, rather than assuming the two match.
 */
export default function TransferDetailPage() {
  const { id } = useParams();

  const canApprove = usePermission('APPROVE_TRANSFER');
  const canDispatch = usePermission('DISPATCH_TRANSFER');
  const canReceive = usePermission('RECEIVE_TRANSFER');
  const canCancel = usePermission('UPDATE_TRANSFER');

  const [transfer, setTransfer] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [receipt, setReceipt] = useState(null);

  const load = useCallback(() => {
    api.get(`/transfers/${id}`)
      .then((res) => { setTransfer(res.data.data); setError(null); })
      .catch((err) => setError(toMessage(err, 'Could not load that transfer')));
  }, [id]);

  useEffect(load, [load]);

  const act = async (path, body = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/transfers/${id}/${path}`, body);
      load();
    } catch (err) {
      setError(toMessage(err, `Could not ${path} this transfer`));
    } finally {
      setBusy(false);
    }
  };

  const submitReceipt = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/transfers/${id}/receive`, {
        lines: receipt.map((l) => ({
          lineId: l.lineId,
          receivedQuantity: Number(l.received || 0),
          damagedQuantity: Number(l.damaged || 0),
        })),
      });
      setReceipt(null);
      load();
    } catch (err) {
      setError(toMessage(err, 'Could not record the receipt'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !transfer) return <p className="text-sm text-rose-700">{error}</p>;
  if (!transfer) return <p className="text-sm text-ink-muted">Loading…</p>;

  const Action = ({ onClick, icon: Icon, children, subtle = false }) => (
    <button
      type="button" onClick={onClick} disabled={busy}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-60 ${
        subtle
          ? 'border border-line-strong text-ink-soft hover:bg-paper'
          : 'bg-slate-900 text-white hover:bg-slate-700'
      }`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {children}
    </button>
  );

  return (
    <DocumentShell
      backTo="/transfers"
      title={transfer.transferNumber}
      mono
      status={transfer.status}
      subtitle={`${transfer.sourceWarehouse?.name ?? '—'} → ${transfer.destinationWarehouse?.name ?? '—'}`}
      error={error}
      actions={(
        <>
          {transfer.status === 'REQUESTED' && canApprove && (
            <Action onClick={() => act('approve')} icon={Check}>Approve</Action>
          )}
          {transfer.status === 'APPROVED' && canDispatch && (
            <Action onClick={() => act('dispatch', { vehicleNumber: transfer.vehicleNumber || undefined })} icon={Send}>
              Dispatch
            </Action>
          )}
          {transfer.status === 'IN_TRANSIT' && canReceive && !receipt && (
            <Action
              icon={PackageCheck}
              onClick={() => setReceipt(transfer.lines.map((l) => ({
                lineId: l.id,
                label: `${l.product?.code ?? ''} ${l.product?.name ?? ''}`.trim(),
                // Defaults to everything arriving intact, which is the usual
                // case — but every figure stays editable.
                received: l.inTransitQuantity,
                damaged: 0,
                inTransit: l.inTransitQuantity,
              })))}
            >
              Receive
            </Action>
          )}
          {['REQUESTED', 'APPROVED'].includes(transfer.status) && canCancel && (
            <Action onClick={() => setCancelling(true)} icon={XCircle} subtle>Cancel</Action>
          )}
        </>
      )}
    >
      {transfer.status === 'REQUESTED' && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Requested but not approved. No stock has left {transfer.sourceWarehouse?.name ?? 'the source'} yet.
        </p>
      )}

      <Totals items={[
        ['Requested', transfer.totals.requested],
        ['In transit', transfer.totals.inTransit],
        ['Received', transfer.totals.received],
        ['Damaged', transfer.totals.damaged],
      ]}
      />

      {receipt && (
        <section className="rounded-lg border border-line-strong bg-white p-4">
          <h2 className="text-sm font-semibold text-ink">What arrived?</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Anything short of the in-transit figure stays in transit — it is not
            written off, because a missing carton is usually on the next vehicle.
          </p>

          <div className="mt-3 space-y-2">
            {receipt.map((line, i) => (
              <div key={line.lineId} className="flex flex-wrap items-end gap-3">
                <span className="min-w-[14rem] flex-1 text-sm text-ink">{line.label}</span>
                <span className="text-xs text-ink-muted">in transit {line.inTransit}</span>
                {[['received', 'Received'], ['damaged', 'Damaged']].map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
                    <input
                      type="number" min={0} max={line.inTransit} value={line[key]}
                      className="w-24 rounded-control border border-line-strong px-2 py-2 text-sm"
                      onChange={(e) => setReceipt((r) => r.map((x, idx) => (
                        idx === i ? { ...x, [key]: e.target.value === '' ? 0 : Number(e.target.value) } : x
                      )))}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button" onClick={() => setReceipt(null)} disabled={busy}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper"
            >
              Cancel
            </button>
            <button
              type="button" onClick={submitReceipt} disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Record receipt
            </button>
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper text-left text-xs font-medium text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              <th className="px-4 py-2.5 font-medium">Requested</th>
              <th className="px-4 py-2.5 font-medium">Dispatched</th>
              <th className="px-4 py-2.5 font-medium">In transit</th>
              <th className="px-4 py-2.5 font-medium">Received</th>
              <th className="px-4 py-2.5 font-medium">Serials</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {transfer.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-4 py-2.5 text-ink">
                  <span className="font-mono text-xs text-ink-muted">{line.product?.code ?? ''}</span>{' '}
                  {line.product?.name ?? '—'}
                </td>
                <td className="px-4 py-2.5">{line.requestedQuantity}</td>
                <td className="px-4 py-2.5">{line.dispatchedQuantity}</td>
                <td className="px-4 py-2.5 font-medium text-ink">{line.inTransitQuantity}</td>
                <td className="px-4 py-2.5">{line.receivedQuantity}</td>
                <td className="px-4 py-2.5 text-xs text-ink-muted">
                  {line.serialNumbers.length > 0 ? `${line.serialNumbers.length} unit(s)` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this transfer?"
          body="Any stock reserved for it is released back to the source warehouse."
          confirmLabel="Cancel transfer"
          destructive
          method="post"
          endpoint={`/transfers/${transfer.id}/cancel`}
          reasonField="Why is this being cancelled?"
          onClose={() => setCancelling(false)}
          onDone={() => { setCancelling(false); load(); }}
        />
      )}
    </DocumentShell>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Loader2, Send, Unlock, XCircle } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import DocumentShell, { Totals } from '../../components/documents/DocumentShell.jsx';

/**
 * A sales order and what can be done to it.
 *
 * Confirming is the step that matters: it RESERVES stock, which is what stops
 * the same units being promised to two customers. Until then an order is a
 * statement of intent and nothing is set aside.
 *
 * Releasing undoes that reservation without cancelling the order — the right
 * action when a customer pushes a delivery out and the stock is needed
 * elsewhere in the meantime.
 */
export default function SalesOrderDetailPage() {
  const { id } = useParams();

  const canConfirm = usePermission('CONFIRM_SALES_ORDER');
  const canCancel = usePermission('UPDATE_SALES_ORDER');
  const canDispatch = usePermission('CREATE_DISPATCH');

  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    api.get(`/sales-orders/${id}`)
      .then((res) => { setOrder(res.data.data); setError(null); })
      .catch((err) => setError(toMessage(err, 'Could not load that order')));
  }, [id]);

  useEffect(load, [load]);

  const act = async (path) => {
    setBusy(true);
    setError(null);
    try {
      // Confirm takes optional serial selections. Omitting them lets the
      // server pick oldest-first, which is what you want unless a specific
      // unit has been promised — and choosing specific units is a job for the
      // dispatch screen, where someone is looking at the shelf.
      await api.post(`/sales-orders/${id}/${path}`, {});
      load();
    } catch (err) {
      setError(toMessage(err, `Could not ${path} this order`));
    } finally {
      setBusy(false);
    }
  };

  if (error && !order) return <p className="text-sm text-rose-700">{error}</p>;
  if (!order) return <p className="text-sm text-ink-muted">Loading…</p>;

  const dispatchable = order.status === 'CONFIRMED' && order.totals.outstanding > 0;

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
      backTo="/sales-orders"
      title={order.salesOrderNumber}
      mono
      status={order.status}
      subtitle={`${order.customer?.name ?? '—'} · from ${order.warehouse?.name ?? '—'}`}
      error={error}
      actions={(
        <>
          {order.status === 'DRAFT' && canConfirm && (
            <Action onClick={() => act('confirm')} icon={Check}>Confirm and reserve</Action>
          )}
          {dispatchable && canDispatch && (
            <Link
              to={`/dispatch-notes/new?order=${order.id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
            >
              <Send className="h-4 w-4" /> Dispatch
            </Link>
          )}
          {order.status === 'CONFIRMED' && canConfirm && (
            <Action onClick={() => act('release')} icon={Unlock} subtle>Release reservation</Action>
          )}
          {['DRAFT', 'CONFIRMED'].includes(order.status) && canCancel && (
            <Action onClick={() => setCancelling(true)} icon={XCircle} subtle>Cancel order</Action>
          )}
        </>
      )}
    >
      {order.status === 'DRAFT' && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Nothing is reserved yet. Until this order is confirmed, another order
          can take the same stock.
        </p>
      )}

      <Totals items={[
        ['Ordered', order.totals.ordered],
        ['Reserved', order.totals.reserved],
        ['Dispatched', order.totals.dispatched],
        ['Outstanding', order.totals.outstanding],
      ]}
      />

      <section className="overflow-hidden rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper text-left text-xs font-medium text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              <th className="px-4 py-2.5 font-medium">Ordered</th>
              <th className="px-4 py-2.5 font-medium">Reserved</th>
              <th className="px-4 py-2.5 font-medium">Dispatched</th>
              <th className="px-4 py-2.5 font-medium">Outstanding</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-4 py-2.5 text-ink">
                  <span className="font-mono text-xs text-ink-muted">{line.product?.code ?? ''}</span>{' '}
                  {line.product?.name ?? '—'}
                  {line.reservedSerialNumbers.length > 0 && (
                    <span className="mt-0.5 block font-mono text-xs text-ink-muted">
                      {line.reservedSerialNumbers.join(', ')}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5">{line.orderedQuantity}</td>
                <td className="px-4 py-2.5">{line.reservedQuantity}</td>
                <td className="px-4 py-2.5">{line.dispatchedQuantity}</td>
                <td className="px-4 py-2.5 font-medium text-ink">{line.outstandingQuantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this order?"
          body="Any stock reserved against it is released back to available."
          confirmLabel="Cancel order"
          destructive
          method="post"
          endpoint={`/sales-orders/${order.id}/cancel`}
          reasonField="Why is this being cancelled?"
          onClose={() => setCancelling(false)}
          onDone={() => { setCancelling(false); load(); }}
        />
      )}
    </DocumentShell>
  );
}

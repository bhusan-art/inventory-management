import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, PackageCheck, XCircle } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';

/**
 * One purchase order, and the decisions that can be taken on it.
 *
 * This page exists because without it the chain is broken: an order is raised
 * in DRAFT, and nothing can be received against it until it is APPROVED. The
 * list screen could create orders and the receipt screen could consume
 * approved ones, with no way in the interface to get from one state to the
 * other — so the goods-receipt screen's order dropdown was permanently empty
 * and the reason was invisible.
 *
 * Approving is separated from raising on purpose, and the permissions differ
 * (`CREATE_PURCHASE_ORDER` vs `APPROVE_PURCHASE_ORDER`). The person who asks
 * for stock should not be the only person who agrees to it.
 */

const STATUS_STYLES = {
  DRAFT: 'bg-slate-100 text-ink-soft ring-slate-200',
  APPROVED: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  PARTIALLY_RECEIVED: 'bg-amber-100 text-amber-800 ring-amber-200',
  RECEIVED: 'bg-sky-100 text-sky-800 ring-sky-200',
  CANCELLED: 'bg-rose-100 text-rose-800 ring-rose-200',
  CLOSED_SHORT: 'bg-slate-200 text-ink-soft ring-slate-300',
};

const humanize = (v) => String(v ?? '').toLowerCase().replace(/_/g, ' ');

export default function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const canApprove = usePermission('APPROVE_PURCHASE_ORDER');
  const canCancel = usePermission('UPDATE_PURCHASE_ORDER');
  const canReceive = usePermission('CREATE_GRN');

  const [po, setPo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    api.get(`/purchase-orders/${id}`)
      .then((res) => { setPo(res.data.data); setError(null); })
      .catch((err) => setError(toMessage(err, 'Could not load that order')));
  }, [id]);

  useEffect(load, [load]);

  const approve = async () => {
    setBusy(true);
    try {
      await api.post(`/purchase-orders/${id}/approve`, {});
      load();
    } catch (err) {
      setError(toMessage(err, 'Could not approve'));
    } finally {
      setBusy(false);
    }
  };

  if (error && !po) return <p className="text-sm text-rose-700">{error}</p>;
  if (!po) return <p className="text-sm text-ink-muted">Loading…</p>;

  const receivable = ['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status) && po.totals.outstanding > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/purchase-orders')} aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted hover:bg-paper hover:text-ink">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-lg font-semibold text-ink">{po.poNumber}</h1>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
                STATUS_STYLES[po.status] ?? STATUS_STYLES.DRAFT
              }`}
              >
                {humanize(po.status)}
              </span>
            </div>
            <p className="text-sm text-ink-muted">
              {po.vendor?.name ?? '—'} · deliver to {po.warehouse?.name ?? '—'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {po.status === 'DRAFT' && canApprove && (
            <button type="button" onClick={approve} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Approve
            </button>
          )}
          {receivable && canReceive && (
            <Link to={`/grn/new?po=${po.id}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover">
              <PackageCheck className="h-4 w-4" /> Receive goods
            </Link>
          )}
          {['DRAFT', 'APPROVED'].includes(po.status) && canCancel && (
            <button type="button" onClick={() => setCancelling(true)}
              className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper">
              <XCircle className="h-4 w-4" /> Cancel order
            </button>
          )}
        </div>
      </div>

      {po.status === 'DRAFT' && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          This order is a draft. Nothing can be received against it until it is approved
          {canApprove ? '.' : ', and approving needs a permission you do not hold.'}
        </p>
      )}

      {error && <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      <section className="grid gap-3 sm:grid-cols-3">
        {[['Ordered', po.totals.ordered], ['Received', po.totals.received],
          ['Outstanding', po.totals.outstanding]].map(([label, value]) => (
            <div key={label} className="rounded-panel border border-line bg-surface p-4">
              <p className="text-xs font-medium text-ink-muted">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
            </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-paper text-left text-xs font-medium text-ink-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Product</th>
              <th className="px-4 py-2.5 font-medium">Ordered</th>
              <th className="px-4 py-2.5 font-medium">Received</th>
              <th className="px-4 py-2.5 font-medium">Outstanding</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {po.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-4 py-2.5 text-ink">
                  <span className="font-mono text-xs text-ink-muted">{line.product?.code ?? ''}</span>{' '}
                  {line.product?.name ?? '—'}
                </td>
                <td className="px-4 py-2.5">{line.orderedQuantity}</td>
                <td className="px-4 py-2.5">{line.receivedQuantity}</td>
                <td className="px-4 py-2.5 font-medium text-ink">{line.outstandingQuantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {cancelling && (
        <ConfirmDialog
          title="Cancel this order?"
          body="The order stops being receivable. Anything already received against it keeps its records."
          confirmLabel="Cancel order"
          destructive
          method="post"
          endpoint={`/purchase-orders/${po.id}/cancel`}
          // The endpoint requires a reason, and the operator supplies it: an
          // order cancelled with no explanation is indistinguishable from one
          // lost track of.
          reasonField="Why is this being cancelled?"
          onClose={() => setCancelling(false)}
          onDone={() => { setCancelling(false); load(); }}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, PackageCheck, ShieldOff, Undo2, Warehouse as WarehouseIcon,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import { StatusBadge } from '../../components/table/DataTable.jsx';

/**
 * The return page — where returned stock stops being a mystery.
 *
 * Its reason to exist is the disposition panel. Until somebody makes that
 * decision the goods sit in quarantine, counted but unsellable, and this is the
 * screen where a person says what they found when they opened the box.
 */
export default function CustomerReturnDetailPage() {
  const { id } = useParams();
  const canApprove = usePermission('APPROVE_RETURN');
  const canReceive = usePermission('CREATE_GRN');
  const canDisposition = usePermission('SET_DISPOSITION');

  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await api.get(`/customer-returns/${id}`);
      setState({ data: res.data.data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: toMessage(err, 'Could not load this return') });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const act = async (path, body) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/customer-returns/${id}/${path}`, body);
      await load();
    } catch (err) {
      setActionError(toMessage(err, 'That action was refused'));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (state.error) return <ErrorNote>{state.error}</ErrorNote>;

  const r = state.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/customer-returns" className="mb-1 flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="h-3.5 w-3.5" /> All customer returns
          </Link>
          <h1 className="font-mono text-lg font-semibold text-ink">{r.returnNumber}</h1>
          <p className="text-sm text-ink-muted">
            {r.customer?.name ?? '—'} · {humanize(r.reason)}
          </p>
        </div>
        <StatusBadge value={r.status} />
      </div>

      {r.totals.pendingDisposition > 0 && (
        <p className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {r.totals.pendingDisposition} unit(s) are in quarantine awaiting inspection. They are
          counted in stock but cannot be sold until a disposition is set.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact icon={Undo2} label="Claimed" value={r.totals.requested} />
        <Fact icon={PackageCheck} label="Arrived" value={r.totals.received} sub={r.receivedAt ? formatDate(r.receivedAt) : 'Not yet received'} />
        <Fact icon={WarehouseIcon} label="Into" value={r.warehouse?.name ?? '—'} sub={r.warehouse?.code} />
        <Fact
          icon={ShieldOff}
          label="Warranties voided"
          value={r.warrantiesVoidedCount}
          sub={r.warrantiesVoidedCount > 0 ? 'The customer no longer holds the unit' : null}
        />
      </div>

      {r.reasonDetail && (
        <section className="rounded-panel border border-line bg-surface p-4">
          <h2 className="mb-1 text-sm font-medium text-ink">What the customer said</h2>
          <p className="whitespace-pre-wrap text-sm text-ink-soft">{r.reasonDetail}</p>
        </section>
      )}

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {canApprove && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RECEIVED'].includes(r.status) && (
        <Workflow status={r.status} pending={r.totals.pendingDisposition} busy={busy} act={act} />
      )}

      <section className="rounded-panel border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-ink">Lines</h2>
        </div>
        <div className="divide-y divide-line/70">
          {r.lines.map((line) => (
            <LineRow
              key={line.id}
              returnStatus={r.status}
              line={line}
              busy={busy}
              canReceive={canReceive}
              canDisposition={canDisposition}
              act={act}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/** Approval and closure — the steps that are nobody's but a manager's. */
function Workflow({ status, pending, busy, act }) {
  const next = {
    DRAFT: [['PENDING_APPROVAL', 'Submit for approval']],
    PENDING_APPROVAL: [['APPROVED', 'Approve'], ['REJECTED', 'Reject']],
    APPROVED: [['CANCELLED', 'Cancel']],
    RECEIVED: [['CLOSED', 'Close']],
  }[status] ?? [];

  const [reason, setReason] = useState('');

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-ink">Workflow</h2>
      <div className="flex flex-wrap items-center gap-2">
        {next.map(([value, label]) => (
          <button
            key={value}
            disabled={busy || (['REJECTED', 'CANCELLED'].includes(value) && reason.trim().length < 3)}
            onClick={() => act('status', { status: value, reason: reason || undefined })}
            className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
              value === 'APPROVED'
                ? 'bg-slate-900 text-white hover:bg-slate-700'
                : 'border border-line-strong text-ink-soft hover:bg-paper'
            }`}
          >
            {label}
          </button>
        ))}
        {status === 'RECEIVED' && pending > 0 && (
          <span className="text-xs text-amber-700">
            {pending} unit(s) still need a disposition before this can close.
          </span>
        )}
      </div>
      {next.some(([v]) => ['REJECTED', 'CANCELLED'].includes(v)) && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required to reject or cancel)"
          className="w-full rounded-control border border-line-strong px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
        />
      )}
    </section>
  );
}

function LineRow({ returnStatus, line, busy, canReceive, canDisposition, act }) {
  const [receiving, setReceiving] = useState('');
  const [serials, setSerials] = useState('');
  const [disposition, setDisposition] = useState('RESTOCK');
  const [quantity, setQuantity] = useState('');
  const [dispositionSerials, setDispositionSerials] = useState('');
  const [notes, setNotes] = useState('');

  const parseSerials = (text) =>
    text.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">{line.product?.name ?? '—'}</p>
          <p className="text-xs text-ink-muted">
            claimed {line.requestedQuantity} · arrived {line.receivedQuantity}
            {line.shortfall > 0 && ` · ${line.shortfall} short`}
            {line.pendingQuantity > 0 && ` · ${line.pendingQuantity} to inspect`}
          </p>
        </div>
        {line.serialNumbers.length > 0 && (
          <p className="font-mono text-xs text-ink-muted">
            {line.serialNumbers.map((s) => s.serialNumber ?? s).join(', ')}
          </p>
        )}
      </div>

      {line.reportedCondition && (
        <p className="text-xs text-ink-soft">Reported: {line.reportedCondition}</p>
      )}

      {canReceive && returnStatus === 'APPROVED' && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-paper p-2">
          <span className="w-32 shrink-0 text-xs text-ink-muted">Receive</span>
          <input
            value={receiving}
            onChange={(e) => setReceiving(e.target.value)}
            placeholder="Qty arrived"
            type="number"
            min="0"
            max={line.requestedQuantity}
            className="w-24 rounded-control border border-line-strong px-2 py-1 text-sm"
          />
          <input
            value={serials}
            onChange={(e) => setSerials(e.target.value)}
            placeholder="Serial numbers, comma separated"
            className="min-w-56 flex-1 rounded-control border border-line-strong px-2 py-1 font-mono text-sm"
          />
          <button
            disabled={busy || !receiving}
            onClick={() => act('receive', {
              lines: [{
                lineId: line.id,
                receivedQuantity: Number(receiving),
                serialNumbers: parseSerials(serials),
              }],
            })}
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Receive
          </button>
          <span className="text-xs text-ink-muted">Goes into quarantine, not available stock.</span>
        </div>
      )}

      {canDisposition && returnStatus === 'RECEIVED' && line.pendingQuantity > 0 && (
        <div className="space-y-2 rounded bg-paper p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-32 shrink-0 text-xs text-ink-muted">Disposition</span>
            <select
              value={disposition}
              onChange={(e) => setDisposition(e.target.value)}
              className="rounded-control border border-line-strong px-2 py-1 text-sm"
            >
              <option value="RESTOCK">Restock — tested, sellable</option>
              <option value="QUARANTINE">Quarantine — hold</option>
              <option value="SCRAP">Scrap — write off</option>
              <option value="RETURN_TO_VENDOR">Return to vendor</option>
            </select>
            <input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Qty"
              type="number"
              min="1"
              max={line.pendingQuantity}
              className="w-20 rounded-control border border-line-strong px-2 py-1 text-sm"
            />
            <input
              value={dispositionSerials}
              onChange={(e) => setDispositionSerials(e.target.value)}
              placeholder="Serials"
              className="min-w-40 flex-1 rounded-control border border-line-strong px-2 py-1 font-mono text-sm"
            />
            <button
              disabled={busy || !quantity}
              onClick={() => act('disposition', {
                lineId: line.id,
                disposition,
                quantity: Number(quantity),
                serialNumbers: parseSerials(dispositionSerials),
                inspectionNotes: notes || undefined,
              })}
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700 disabled:opacity-40"
            >
              Apply
            </button>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What you found on inspection"
            className="w-full rounded-control border border-line-strong px-2 py-1 text-sm"
          />
          {/* Said plainly, because it is the decision with real consequences. */}
          <p className="text-xs text-ink-muted">
            {disposition === 'RESTOCK' && 'Puts the unit back into sellable stock. It will ship to the next customer.'}
            {disposition === 'QUARANTINE' && 'Keeps the unit in stock but unsellable, and records that you looked.'}
            {disposition === 'SCRAP' && 'Takes the unit out of stock permanently.'}
            {disposition === 'RETURN_TO_VENDOR' && 'Earmarks it. The goods stay here until a vendor return is approved and sent.'}
          </p>
        </div>
      )}

      {line.dispositions.length > 0 && (
        <ul className="space-y-1">
          {line.dispositions.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="rounded-full border border-line bg-white px-2 py-0.5 text-ink-soft">
                {humanize(d.disposition)} × {d.quantity}
              </span>
              {d.inspectionNotes && <span className="text-ink-soft">{d.inspectionNotes}</span>}
              <span className="text-ink-muted">
                {d.decidedBy?.name ?? ''} {formatDate(d.decidedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Fact({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <p className="mt-1 truncate text-sm font-medium text-ink">{value ?? '—'}</p>
      {sub && <p className="truncate text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

function ErrorNote({ children }) {
  return (
    <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </div>
  );
}

const humanize = (v) => (v ? String(v).replace(/_/g, ' ').toLowerCase() : '—');

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

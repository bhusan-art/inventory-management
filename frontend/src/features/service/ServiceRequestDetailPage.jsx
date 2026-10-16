import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, Clock, Package, ShieldCheck, ShieldOff, User as UserIcon, Wrench,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import { StatusBadge } from '../../components/table/DataTable.jsx';

/**
 * The ticket page — where a service job is actually worked.
 *
 * The available actions come from `allowedTransitions` on the API response,
 * which the backend derives from the same transition table it enforces. Nothing
 * here decides what is legal; a button the API would refuse is never drawn, and
 * if it somehow were, the API would still refuse it.
 */
export default function ServiceRequestDetailPage() {
  const { id } = useParams();
  const canWork = usePermission('WORK_SERVICE_REQUEST');
  const canAssign = usePermission('ASSIGN_SERVICE_REQUEST');

  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await api.get(`/service-requests/${id}`);
      setState({ data: res.data.data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: toMessage(err, 'Could not load this ticket') });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /** Every action is the same shape: post, then reload from the server. */
  const act = async (path, body) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/service-requests/${id}/${path}`, body);
      await load();
    } catch (err) {
      setActionError(toMessage(err, 'That action was refused'));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (state.error) return <ErrorNote>{state.error}</ErrorNote>;

  const t = state.data;
  const held = Boolean(t.receivedAt) && !t.returnedAt;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/service-requests" className="mb-1 flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="h-3.5 w-3.5" /> All service requests
          </Link>
          <h1 className="font-mono text-lg font-semibold text-ink">{t.ticketNumber}</h1>
          <p className="text-sm text-ink-muted">
            {t.customer?.name ?? '—'} · {t.product?.name ?? '—'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CoverBadge applicable={t.warrantyApplicable} />
          <span className="rounded-full border border-line bg-paper px-2 py-0.5 text-xs text-ink-soft">
            {String(t.priority ?? '').toLowerCase()}
          </span>
          <StatusBadge value={t.status} />
        </div>
      </div>

      {t.slaBreached && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          SLA passed on {formatDateTime(t.slaDueDate)}. The clock runs from when the fault was
          reported, so raising the priority later does not reset it.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          icon={Package}
          label="Unit"
          value={t.serialNumber?.serialNumber ?? 'No serial recorded'}
          sub={t.serialNumber?.status ? humanize(t.serialNumber.status) : null}
        />
        <Fact icon={UserIcon} label="Engineer" value={t.assignedTo?.name ?? 'Unassigned'} />
        <Fact icon={Clock} label="Reported" value={formatDateTime(t.reportedDate)} sub={`SLA ${formatDateTime(t.slaDueDate)}`} />
        <Fact
          icon={Wrench}
          label="With us"
          value={held ? 'Yes — at the service centre' : 'No'}
          sub={t.receivedAt ? `Received ${formatDateTime(t.receivedAt)}` : null}
        />
      </div>

      <section className="rounded-panel border border-line bg-surface p-4">
        <h2 className="mb-1 text-sm font-medium text-ink">Reported fault</h2>
        <p className="whitespace-pre-wrap text-sm text-ink-soft">{t.issueDescription}</p>
        {t.rootCause && (
          <>
            <h3 className="mt-3 text-sm font-medium text-ink">Root cause</h3>
            <p className="whitespace-pre-wrap text-sm text-ink-soft">{t.rootCause}</p>
          </>
        )}
        {t.resolution && (
          <>
            <h3 className="mt-3 text-sm font-medium text-ink">Resolution</h3>
            <p className="whitespace-pre-wrap text-sm text-ink-soft">{t.resolution}</p>
          </>
        )}
        {t.replacementSerialNumber && (
          <p className="mt-3 text-sm text-ink-soft">
            Replaced by{' '}
            <Link
              to={`/serials/${t.replacementSerialNumber.id}`}
              className="font-mono text-ink underline decoration-slate-300"
            >
              {t.replacementSerialNumber.serialNumber}
            </Link>
          </p>
        )}
      </section>

      {t.warranty && (
        <section className="rounded-panel border border-line bg-surface p-4">
          <h2 className="mb-2 text-sm font-medium text-ink">Cover at the time of the report</h2>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Pair label="Warranty" value={t.warranty.warrantyNumber} mono />
            <Pair label="Ran until" value={formatDate(t.warrantyEndDateAtRaise ?? t.warranty.endDate)} />
            <Pair label="State today" value={humanize(t.warranty.state)} />
          </dl>
          {/* Said plainly, because it is the question a customer will ask. */}
          <p className="mt-3 text-xs text-ink-muted">
            Entitlement was decided when the fault was reported and does not change afterwards. A
            warranty that lapses while the unit is with us does not make the repair chargeable.
          </p>
        </section>
      )}

      {actionError && <ErrorNote>{actionError}</ErrorNote>}

      {(canWork || canAssign) && (
        <Actions ticket={t} held={held} busy={busy} canWork={canWork} canAssign={canAssign} act={act} />
      )}

      <section className="rounded-panel border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-ink">History</h2>
          <p className="text-xs text-ink-muted">{t.activity.length} entr{t.activity.length === 1 ? 'y' : 'ies'}</p>
        </div>
        <ol className="divide-y divide-line/70">
          {t.activity.map((a) => (
            <li key={a.id} className="flex gap-3 px-4 py-3">
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  {a.fromStatus && a.fromStatus !== a.toStatus ? `${humanize(a.fromStatus)} → ` : ''}
                  <span className="font-medium">{humanize(a.toStatus)}</span>
                </p>
                {a.note && <p className="mt-0.5 text-xs text-ink-soft">{a.note}</p>}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-ink-muted">{formatDateTime(a.at)}</p>
                {a.performedBy?.name && <p className="text-xs text-ink-muted">{a.performedBy.name}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * The action panel.
 *
 * Receiving comes first because it is what puts the unit into our stock, and
 * nothing else can happen to a unit we are not holding.
 */
function Actions({ ticket, held, busy, canWork, canAssign, act }) {
  const [warehouse, setWarehouse] = useState('');
  const [warehouses, setWarehouses] = useState([]);
  const [note, setNote] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendors, setVendors] = useState([]);
  const [replacement, setReplacement] = useState('');

  const needsVendor = ticket.allowedTransitions?.includes('SENT_TO_VENDOR');
  const canReceive = canWork && !ticket.receivedAt && ticket.serialNumber;

  useEffect(() => {
    if (!canReceive) return;
    api.get('/warehouses', { params: { limit: 100 } })
      .then((res) => setWarehouses(res.data.data))
      .catch(() => setWarehouses([]));
  }, [canReceive]);

  useEffect(() => {
    if (!needsVendor) return;
    api.get('/vendors', { params: { limit: 100 } })
      .then((res) => setVendors(res.data.data))
      .catch(() => setVendors([]));
  }, [needsVendor]);

  const transitions = (ticket.allowedTransitions ?? []).filter((s) => s !== 'CLOSED' && s !== 'REPLACED');

  return (
    <section className="space-y-4 rounded-panel border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-ink">Actions</h2>

      {canAssign && !['CLOSED', 'REJECTED'].includes(ticket.status) && (
        <Row label="Priority">
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => (
            <button
              key={p}
              disabled={busy || p === ticket.priority}
              onClick={() => act('assign', { priority: p })}
              className="rounded-control border border-line-strong px-2.5 py-1 text-xs text-ink-soft hover:bg-paper disabled:opacity-40"
            >
              {p.toLowerCase()}
            </button>
          ))}
        </Row>
      )}

      {canReceive && (
        <Row label="Receive the unit">
          <select
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value)}
            className="rounded-control border border-line-strong px-2 py-1 text-sm"
          >
            <option value="">Choose a location…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button
            disabled={busy || !warehouse}
            onClick={() => act('receive', { warehouse, note: note || undefined })}
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Receive
          </button>
          {/* Worth saying, because it surprises people: the unit becomes ours
              to count while staying the customer's to own. */}
          <span className="text-xs text-ink-muted">
            Adds the unit to stock in the under-service bucket.
          </span>
        </Row>
      )}

      {canWork && transitions.length > 0 && (
        <Row label="Move to">
          {transitions.map((s) => (
            <button
              key={s}
              disabled={busy || (s === 'SENT_TO_VENDOR' && !vendor)}
              onClick={() => act('status', {
                status: s,
                note: note || undefined,
                vendor: s === 'SENT_TO_VENDOR' ? vendor : undefined,
              })}
              className="rounded-control border border-line-strong px-2.5 py-1 text-xs text-ink-soft hover:bg-paper disabled:opacity-40"
            >
              {humanize(s)}
            </button>
          ))}
          {needsVendor && (
            <select
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="rounded-control border border-line-strong px-2 py-1 text-sm"
            >
              <option value="">Vendor for an RMA…</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
        </Row>
      )}

      {canWork && ticket.status === 'REPAIRED' && held && (
        <Row label="Return to customer">
          <button
            disabled={busy || note.trim().length < 5}
            onClick={() => act('return', { resolution: note })}
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Return repaired unit
          </button>
          <span className="text-xs text-ink-muted">Needs a note describing what was done.</span>
        </Row>
      )}

      {canWork && ticket.allowedTransitions?.includes('REPLACED') && (
        <Row label="Replace the unit">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value.toUpperCase())}
            placeholder="Replacement serial"
            className="w-48 rounded-control border border-line-strong px-2 py-1 font-mono text-sm"
          />
          <button
            disabled={busy || !replacement || note.trim().length < 5}
            onClick={() => act('replace', { replacementSerialNumber: replacement, resolution: note })}
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Issue replacement
          </button>
          <span className="text-xs text-ink-muted">
            Cover carries over with its original end date — it does not restart.
          </span>
        </Row>
      )}

      {canWork && ticket.allowedTransitions?.includes('CLOSED') && (
        <Row label="Close">
          <button
            disabled={busy}
            onClick={() => act('close', { resolution: note || undefined })}
            className="rounded-control border border-line-strong px-3 py-1 text-sm text-ink-soft hover:bg-paper disabled:opacity-40"
          >
            Close ticket
          </button>
          {held && (
            <span className="text-xs text-amber-700">
              We still hold this unit — return or replace it first.
            </span>
          )}
        </Row>
      )}

      {(canWork || canAssign) && !['CLOSED'].includes(ticket.status) && (
        <div>
          <label htmlFor="sr-note" className="block text-xs text-ink-muted">Note</label>
          <textarea
            id="sr-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Recorded against whichever action you take next"
            className="mt-1 w-full rounded-control border border-line-strong px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
      )}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
      <span className="w-40 shrink-0 text-xs text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function CoverBadge({ applicable }) {
  if (applicable === null || applicable === undefined) return null;
  return applicable ? (
    <span className="flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
      <ShieldCheck className="h-3 w-3" /> in warranty
    </span>
  ) : (
    <span className="flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-xs text-ink-soft">
      <ShieldOff className="h-3 w-3" /> chargeable
    </span>
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

function Pair({ label, value, mono }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`text-sm text-ink ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</dd>
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

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

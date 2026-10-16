import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft } from 'lucide-react';

/**
 * The frame every document screen shares: a back arrow, a title, the error
 * banner, and a status badge that reads the same everywhere.
 *
 * The badge colours are keyed by meaning rather than by document. A transfer
 * `IN_TRANSIT` and a dispatch `DISPATCHED` are the same kind of fact — goods
 * have left and have not arrived — and someone who learns the colours on one
 * screen should not have to relearn them on the next.
 */

const TONE = {
  draft: 'bg-slate-100 text-ink-soft ring-slate-200',
  go: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  moving: 'bg-amber-100 text-amber-800 ring-amber-200',
  done: 'bg-sky-100 text-sky-800 ring-sky-200',
  stopped: 'bg-rose-100 text-rose-800 ring-rose-200',
};

const STATUS_TONE = {
  DRAFT: 'draft', REQUESTED: 'draft', OPEN: 'draft', PENDING: 'draft',
  APPROVED: 'go', CONFIRMED: 'go', RELEASED: 'go', COUNTING: 'go',
  IN_TRANSIT: 'moving', DISPATCHED: 'moving', PARTIALLY_RECEIVED: 'moving',
  PARTIALLY_DISPATCHED: 'moving', IN_PROGRESS: 'moving',
  RECEIVED: 'done', DELIVERED: 'done', COMPLETED: 'done', CLOSED: 'done', POSTED: 'done',
  CANCELLED: 'stopped', REJECTED: 'stopped', CLOSED_SHORT: 'stopped',
};

export const humanize = (v) => String(v ?? '').toLowerCase().replace(/_/g, ' ');

export function StatusBadge({ status }) {
  const tone = TONE[STATUS_TONE[status] ?? 'draft'];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${tone}`}>
      {humanize(status)}
    </span>
  );
}

/** Three numbers across the top of a document — ordered, moved, outstanding. */
export function Totals({ items }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-panel border border-line bg-surface p-4">
          <p className="text-xs font-medium text-ink-muted">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
        </div>
      ))}
    </section>
  );
}

export default function DocumentShell({
  backTo, title, subtitle, status, actions, error, children, mono = false,
}) {
  const navigate = useNavigate();

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button" onClick={() => navigate(backTo)} aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className={`text-lg font-semibold text-ink ${mono ? 'font-mono' : ''}`}>{title}</h1>
              {status && <StatusBadge status={status} />}
            </div>
            {subtitle && <p className="text-sm text-ink-muted">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {children}
    </div>
  );
}

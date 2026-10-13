import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Inbox, AlertCircle, Loader2 } from 'lucide-react';

/**
 * Server-driven table. Sorting, filtering and pagination all happen in the API,
 * because the client only ever holds one page and cannot sort what it has not
 * fetched.
 *
 * Columns carrying a `permission` are removed before render — see masterConfig.
 */
export default function DataTable({
  columns, rows, meta, loading, error, onPageChange, rowLink, emptyMessage = 'Nothing here yet',
}) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-4 py-2.5 text-left font-medium text-slate-600">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            )}

            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-slate-500">
                  <Inbox className="mx-auto mb-2 h-6 w-6 text-slate-400" />
                  {emptyMessage}
                </td>
              </tr>
            )}

            {!loading && rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50">
                {columns.map((c, i) => {
                  const content = c.status
                    ? <StatusBadge value={row[c.key]} />
                    : c.render ? c.render(row) : (row[c.key] ?? '—');
                  return (
                    <td key={c.key} className={`px-4 py-2.5 ${c.mono ? 'font-mono text-xs' : 'text-slate-700'}`}>
                      {/* Only the first cell links, so the row stays selectable
                          and copyable rather than being one big click target. */}
                      {rowLink && i === 0
                        ? <Link to={rowLink(row)} className="text-slate-900 underline-offset-2 hover:underline">{content}</Link>
                        : content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {meta && meta.pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
          <span className="text-slate-500">
            Page {meta.page} of {meta.pages} · {meta.total} records
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => onPageChange(meta.page - 1)}
              disabled={meta.page <= 1}
              className="rounded border border-slate-300 p-1.5 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => onPageChange(meta.page + 1)}
              disabled={meta.page >= meta.pages}
              className="rounded border border-slate-300 p-1.5 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const TONES = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  INACTIVE: 'bg-slate-100 text-slate-600 border-slate-200',
  DISCONTINUED: 'bg-amber-50 text-amber-700 border-amber-200',
  BLACKLISTED: 'bg-red-50 text-red-700 border-red-200',
  ON_HOLD: 'bg-amber-50 text-amber-700 border-amber-200',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-blue-50 text-blue-700 border-blue-200',
  IN_TRANSIT: 'bg-violet-50 text-violet-700 border-violet-200',
  PARTIALLY_RECEIVED: 'bg-amber-50 text-amber-700 border-amber-200',
  RECEIVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  POSTED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border-blue-200',
  CANCELLED: 'bg-slate-100 text-slate-500 border-slate-200',
  DRAFT: 'bg-slate-100 text-slate-600 border-slate-200',
  LOCKED: 'bg-red-50 text-red-700 border-red-200',
  PENDING_ACTIVATION: 'bg-amber-50 text-amber-700 border-amber-200',
  CONFIRMED: 'bg-blue-50 text-blue-700 border-blue-200',
  PARTIALLY_DISPATCHED: 'bg-amber-50 text-amber-700 border-amber-200',
  DISPATCHED: 'bg-violet-50 text-violet-700 border-violet-200',
  DELIVERED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CLOSED: 'bg-slate-100 text-slate-600 border-slate-200',
  PARTIALLY_RETURNED: 'bg-amber-50 text-amber-700 border-amber-200',
  RETURNED: 'bg-red-50 text-red-700 border-red-200',
};

export function StatusBadge({ value }) {
  if (!value) return '—';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${TONES[value] ?? TONES.INACTIVE}`}>
      {value.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

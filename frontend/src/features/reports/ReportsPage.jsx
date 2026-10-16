import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Download, EyeOff, FileSpreadsheet, FileText } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';

/**
 * Reports.
 *
 * The menu comes from the API already filtered to what this actor may run, so
 * the page never offers something that would then be refused. Columns arrive
 * pre-filtered the same way — the table renders what it is given rather than
 * deciding for itself what to hide.
 */
export default function ReportsPage() {
  const canExport = usePermission('EXPORT_DATA');

  const [reports, setReports] = useState([]);
  const [active, setActive] = useState(null);
  const [filters, setFilters] = useState({});
  const [state, setState] = useState({ data: null, meta: null, loading: false, error: null });
  const [downloading, setDownloading] = useState(null);

  useEffect(() => {
    api.get('/reports')
      .then((res) => {
        setReports(res.data.data);
        if (res.data.data.length > 0) setActive(res.data.data[0].key);
      })
      .catch(() => setReports([]));
  }, []);

  const run = useCallback(async (key, params) => {
    setState({ data: null, meta: null, loading: true, error: null });
    try {
      const res = await api.get(`/reports/${key}`, { params });
      setState({ data: res.data.data, meta: res.data.meta, loading: false, error: null });
    } catch (err) {
      setState({
        data: null, meta: null, loading: false,
        error: toMessage(err, 'Could not run this report'),
      });
    }
  }, []);

  useEffect(() => {
    if (active) run(active, filters);
  }, [active, filters, run]);

  /**
   * Fetched through the API client, not a plain link.
   *
   * The access token lives in memory and travels in a header; a new tab or an
   * <a download> carries neither and would 401. Same reasoning as the serial
   * label button in Phase 6.
   */
  const download = async (format) => {
    setDownloading(format);
    try {
      const res = await api.get(`/reports/${active}/export`, {
        params: { ...filters, format },
        responseType: 'blob',
      });

      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${active}-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setState((s) => ({ ...s, error: toMessage(err, 'The export was refused') }));
    } finally {
      setDownloading(null);
    }
  };

  if (reports.length === 0) {
    return <p className="text-sm text-ink-soft">No reports are available to you.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">Reports</h1>

        {canExport && state.data && (
          <div className="flex gap-2">
            <button
              onClick={() => download('csv')}
              disabled={downloading !== null}
              className="flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
            >
              <FileText className="h-4 w-4" /> {downloading === 'csv' ? 'Preparing…' : 'CSV'}
            </button>
            <button
              onClick={() => download('xlsx')}
              disabled={downloading !== null}
              className="flex items-center gap-1.5 rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            >
              <FileSpreadsheet className="h-4 w-4" /> {downloading === 'xlsx' ? 'Preparing…' : 'Excel'}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {reports.map((r) => (
          <button
            key={r.key}
            onClick={() => { setActive(r.key); setFilters({}); }}
            className={`rounded-full border px-3 py-1 text-sm ${
              active === r.key
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-line-strong text-ink-soft hover:bg-paper'
            }`}
          >
            {r.name}
          </button>
        ))}
      </div>

      <Filters active={active} filters={filters} onChange={setFilters} />

      {state.error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {state.error}
        </div>
      )}

      {state.loading && <p className="text-sm text-ink-muted">Running…</p>}

      {state.data && (
        <section className="rounded-panel border border-line bg-surface">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-sm font-medium text-ink">{state.data.name}</h2>
            <p className="text-xs text-ink-muted">
              {state.meta.total.toLocaleString('en-IN')} row{state.meta.total === 1 ? '' : 's'}
              {state.meta.truncated && ` · showing the first ${state.meta.returned}`}
            </p>
          </div>

          {state.meta.withheldColumns > 0 && (
            // Said plainly. The reader should know the report has more columns
            // than they can see, rather than wondering why a field is missing.
            <p className="flex items-center gap-1.5 border-b border-slate-100 bg-paper px-4 py-2 text-xs text-ink-soft">
              <EyeOff className="h-3.5 w-3.5" />
              {state.meta.withheldColumns} column{state.meta.withheldColumns === 1 ? '' : 's'} hidden —
              your role does not include permission to see {state.meta.withheldColumns === 1 ? 'it' : 'them'}.
              Exports omit {state.meta.withheldColumns === 1 ? 'it' : 'them'} too.
            </p>
          )}

          {state.data.rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">Nothing to report.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-paper">
                  <tr>
                    {state.data.columns.map((c) => (
                      <th
                        key={c.key}
                        className={`whitespace-nowrap px-3 py-2 text-xs font-medium text-ink-soft ${
                          c.type === 'number' ? 'text-right' : 'text-left'
                        }`}
                      >
                        {c.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {state.data.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-paper">
                      {state.data.columns.map((c) => (
                        <td
                          key={c.key}
                          className={`whitespace-nowrap px-3 py-1.5 ${
                            c.type === 'number'
                              ? 'text-right tabular-nums text-ink'
                              : 'text-ink-soft'
                          }`}
                        >
                          {format(row[c.key], c.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {state.meta.truncated && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-ink-muted">
              <Download className="mr-1 inline h-3 w-3" />
              The table shows the first {state.meta.returned} rows. Export to get all{' '}
              {state.meta.total.toLocaleString('en-IN')}.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/** Per-report filters. Only the ones a report actually uses. */
function Filters({ active, filters, onChange }) {
  const set = (key) => (e) => onChange({ ...filters, [key]: e.target.value || undefined });

  const dateRange = ['stock-movement', 'service-sla', 'vendor-performance'].includes(active);
  const expiry = active === 'warranty-expiry';
  const reorder = active === 'stock-on-hand';

  if (!dateRange && !expiry && !reorder) return null;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-panel border border-line bg-surface p-3">
      {dateRange && (
        <>
          <Field label="From">
            <input type="date" value={filters.from ?? ''} onChange={set('from')} className={inputClass} />
          </Field>
          <Field label="To">
            <input type="date" value={filters.to ?? ''} onChange={set('to')} className={inputClass} />
          </Field>
        </>
      )}

      {expiry && (
        <Field label="Expiring within">
          <select value={filters.withinDays ?? ''} onChange={set('withinDays')} className={inputClass}>
            <option value="">Any time</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">A year</option>
          </select>
        </Field>
      )}

      {reorder && (
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={filters.belowReorderOnly === 'true'}
            onChange={(e) => onChange({
              ...filters,
              belowReorderOnly: e.target.checked ? 'true' : undefined,
            })}
          />
          Below reorder level only
        </label>
      )}
    </div>
  );
}

const inputClass = 'rounded-control border border-line-strong px-2 py-1 text-sm focus:border-slate-500 focus:outline-none';

function Field({ label, children }) {
  return (
    <div>
      <span className="mb-0.5 block text-xs text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function format(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'date') {
    return new Date(value).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  }
  if (type === 'number') return Number(value).toLocaleString('en-IN');
  return String(value);
}

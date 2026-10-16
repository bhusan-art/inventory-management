import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Eye, EyeOff, Filter, RotateCcw, Search, ShieldAlert,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';

/**
 * The audit trail.
 *
 * Written since Phase 1 and never readable until now, which is the normal fate
 * of an audit log and the reason this page exists: a trail nobody can query is
 * a compliance artefact rather than a tool.
 *
 * Two deliberate choices.
 *
 * The filter vocabulary comes from the DATA — a `/vocabulary` endpoint returns
 * the distinct actions and modules actually present. A hard-coded dropdown is a
 * second copy of the action list, and the first phase that adds an action
 * without updating it produces a filter that silently cannot find the new
 * records.
 *
 * `before`/`after` payloads are shown only when the server sent them. A
 * redacted entry arrives with both nulled, and the page says so plainly rather
 * than rendering an empty diff — an empty diff reads as "nothing changed",
 * which is a different and wrong statement.
 */

/**
 * Styling per severity. The LIST of severities comes from the API, not from
 * here: the first version of this page knew three of the four, so every NOTICE
 * entry — a third of the trail — showed as "Info" through the fallback and
 * could not be filtered for at all. Anything unrecognised still renders rather
 * than crashing, but it renders under its own name.
 */
const SEVERITY = {
  CRITICAL: { label: 'Critical', chip: 'bg-rose-100 text-rose-800 ring-rose-200' },
  WARNING: { label: 'Warning', chip: 'bg-amber-100 text-amber-800 ring-amber-200' },
  NOTICE: { label: 'Notice', chip: 'bg-sky-100 text-sky-800 ring-sky-200' },
  INFO: { label: 'Info', chip: 'bg-slate-100 text-ink-soft ring-slate-200' },
};

const CARD_SEVERITIES = ['CRITICAL', 'WARNING', 'NOTICE'];

const EMPTY = {
  action: '', module: '', severity: '', search: '', from: '', to: '', page: 1,
};

function Chip({ severity }) {
  const meta = SEVERITY[severity];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta?.chip ?? SEVERITY.INFO.chip}`}>
      {meta?.label ?? severity ?? 'Unknown'}
    </span>
  );
}

function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

/**
 * The field-level diff.
 *
 * Only keys that actually differ are listed. Dumping both documents side by
 * side for a one-field change buries the change — and "what changed" is the
 * question an auditor is asking.
 */
function Diff({ before, after }) {
  const rows = useMemo(() => {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
    return keys
      .map((key) => ({ key, from: before?.[key], to: after?.[key] }))
      .filter(({ from, to }) => JSON.stringify(from) !== JSON.stringify(to));
  }, [before, after]);

  if (rows.length === 0) {
    return <p className="text-xs text-ink-muted">No field-level changes were recorded.</p>;
  }

  const show = (v) => (v === undefined || v === null || v === ''
    ? <span className="text-ink-muted">empty</span>
    : <span className="break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>);

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-ink-muted">
          <th className="py-1 pr-3 font-medium">Field</th>
          <th className="py-1 pr-3 font-medium">Before</th>
          <th className="py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, from, to }) => (
          <tr key={key} className="border-t border-slate-100 align-top">
            <td className="py-1 pr-3 font-mono text-ink-soft">{key}</td>
            <td className="py-1 pr-3 text-rose-700">{show(from)}</td>
            <td className="py-1 text-emerald-700">{show(to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Detail({ entry }) {
  if (entry.redacted) {
    return (
      <div className="flex items-start gap-2 rounded-md bg-paper p-3 text-xs text-ink-soft">
        <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
        <span>
          The payload for this entry is withheld. The entry itself — who, what and
          when — is intact; only the field values are hidden.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md bg-paper p-3">
      <Diff before={entry.before} after={entry.after} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-ink-soft sm:grid-cols-4">
        {entry.ip && (<><dt className="font-medium">IP</dt><dd className="font-mono">{entry.ip}</dd></>)}
        {entry.requestId && (<><dt className="font-medium">Request</dt><dd className="font-mono break-all">{entry.requestId}</dd></>)}
        {entry.reason && (<><dt className="font-medium">Reason</dt><dd>{entry.reason}</dd></>)}
        {entry.recordId && (<><dt className="font-medium">Record</dt><dd className="font-mono break-all">{entry.recordId}</dd></>)}
      </dl>
    </div>
  );
}

export default function AuditLogPage() {
  const [vocabulary, setVocabulary] = useState({ actions: [], modules: [], severities: [] });
  const [summary, setSummary] = useState(null);
  const [query, setQuery] = useState(EMPTY);
  const [term, setTerm] = useState('');
  const [state, setState] = useState({ items: [], meta: null, loading: true, error: null });
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const EMPTY_VOCAB = { actions: [], modules: [], severities: [] };
    api.get('/audit-logs/vocabulary')
      // `?? EMPTY_VOCAB` because a 200 is not a promise about the body. A
      // misconfigured proxy returning its own HTML error page with a 200 made
      // this crash the whole screen, which is a worse failure than the filters
      // simply being empty.
      .then((res) => setVocabulary(res.data?.data ?? EMPTY_VOCAB))
      .catch(() => setVocabulary(EMPTY_VOCAB));

    api.get('/audit-logs/summary', { params: { days: 7 } })
      .then((res) => setSummary(res.data?.data ?? null))
      .catch(() => setSummary(null));
  }, []);

  const load = useCallback(async (q) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v != null));
      const res = await api.get('/audit-logs', { params: { ...params, limit: 50 } });
      setState({ items: res.data.data, meta: res.data.meta, loading: false, error: null });
    } catch (err) {
      setState({
        items: [], meta: null, loading: false,
        error: toMessage(err, 'Could not load the audit trail'),
      });
    }
  }, []);

  useEffect(() => { load(query); }, [query, load]);

  const set = (patch) => setQuery((q) => ({ ...q, ...patch, page: 1 }));

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => set({ search: term }), 350);
    return () => clearTimeout(id);
  }, [term]);

  const filtered = Object.entries(query).some(([k, v]) => k !== 'page' && v !== '');
  const meta = state.meta;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Audit trail</h1>
          <p className="text-sm text-ink-soft">
            Every recorded change, append-only. Entries cannot be edited or removed.
          </p>
        </div>
        {filtered && (
          <button
            type="button"
            onClick={() => { setTerm(''); setQuery(EMPTY); }}
            className="inline-flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:bg-paper"
          >
            <RotateCcw className="h-4 w-4" /> Clear filters
          </button>
        )}
      </header>

      {summary && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CARD_SEVERITIES.map((level) => (
            <div key={level} className="rounded-panel border border-line bg-surface p-4">
              <p className="text-xs font-medium text-ink-muted">{SEVERITY[level].label} · 7 days</p>
              <p className="mt-1 text-2xl font-semibold text-ink">{summary.bySeverity?.[level] ?? 0}</p>
            </div>
          ))}
          <div className="rounded-panel border border-line bg-surface p-4">
            <p className="text-xs font-medium text-ink-muted">Busiest module</p>
            <p className="mt-1 truncate text-2xl font-semibold text-ink">
              {summary.byModule?.[0]?.module ?? '—'}
            </p>
          </div>
        </section>
      )}

      {summary?.criticalRecent?.length > 0 && (
        <section className="rounded-lg border border-rose-200 bg-rose-50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-rose-900">
            <ShieldAlert className="h-4 w-4" /> Critical events in the last 7 days
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-rose-900">
            {summary.criticalRecent.slice(0, 5).map((e) => (
              <li key={e._id ?? e.id} className="flex flex-wrap gap-x-2">
                <span className="font-mono text-xs">{when(e.createdAt)}</span>
                <span className="font-medium">{e.action}</span>
                <span className="text-rose-700">{e.actorName ?? 'system'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-panel border border-line bg-surface">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-3">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search record, actor or action"
              className="w-full rounded-control border border-line-strong py-2 pl-8 pr-3 text-sm"
            />
          </div>

          <label className="text-xs text-ink-soft">
            Module
            <select
              value={query.module}
              onChange={(e) => set({ module: e.target.value })}
              className="mt-1 block rounded-control border border-line-strong px-2 py-2 text-sm"
            >
              <option value="">All</option>
              {vocabulary.modules.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>

          <label className="text-xs text-ink-soft">
            Action
            <select
              value={query.action}
              onChange={(e) => set({ action: e.target.value })}
              className="mt-1 block max-w-[14rem] rounded-control border border-line-strong px-2 py-2 text-sm"
            >
              <option value="">All</option>
              {vocabulary.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>

          <label className="text-xs text-ink-soft">
            Severity
            <select
              value={query.severity}
              onChange={(e) => set({ severity: e.target.value })}
              className="mt-1 block rounded-control border border-line-strong px-2 py-2 text-sm"
            >
              <option value="">All</option>
              {vocabulary.severities.map((s) => (
                <option key={s} value={s}>{SEVERITY[s]?.label ?? s}</option>
              ))}
            </select>
          </label>

          <label className="text-xs text-ink-soft">
            From
            <input
              type="date" value={query.from}
              onChange={(e) => set({ from: e.target.value })}
              className="mt-1 block rounded-control border border-line-strong px-2 py-2 text-sm"
            />
          </label>

          <label className="text-xs text-ink-soft">
            To
            <input
              type="date" value={query.to}
              onChange={(e) => set({ to: e.target.value })}
              className="mt-1 block rounded-control border border-line-strong px-2 py-2 text-sm"
            />
          </label>
        </div>

        {state.error && (
          <div className="flex items-center gap-2 p-4 text-sm text-rose-700">
            <AlertTriangle className="h-4 w-4" /> {state.error}
          </div>
        )}

        {state.loading && <p className="p-4 text-sm text-ink-muted">Loading…</p>}

        {!state.loading && !state.error && state.items.length === 0 && (
          <div className="flex flex-col items-center gap-1 p-10 text-center">
            <Filter className="h-5 w-5 text-ink-muted" />
            <p className="text-sm text-ink-soft">
              {filtered ? 'No entries match these filters.' : 'No audit entries yet.'}
            </p>
          </div>
        )}

        {!state.loading && state.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs font-medium text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Module</th>
                  <th className="px-3 py-2 font-medium">Record</th>
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium sr-only">Detail</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((entry) => {
                  const id = entry.id ?? entry._id;
                  const expanded = open === id;
                  return (
                    // The key belongs on the FRAGMENT, not the first row: the
                    // shorthand `<>` cannot take one, so a row and its detail
                    // row would share a parent React could not identify, and
                    // expanding one row re-keys every row below it.
                    <Fragment key={id}>
                      <tr className="border-t border-slate-100">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-ink-soft">
                          {when(entry.createdAt)}
                        </td>
                        <td className="px-3 py-2">
                          {/* The NAME is stored on the entry, not joined. A user
                              deleted two years later must not erase who acted. */}
                          {entry.actorName ?? <span className="text-ink-muted">system</span>}
                        </td>
                        <td className="px-3 py-2 font-medium text-ink">{entry.action}</td>
                        <td className="px-3 py-2 text-ink-soft">{entry.module}</td>
                        <td className="max-w-[16rem] truncate px-3 py-2 text-ink-soft">
                          {entry.recordLabel ?? entry.recordId ?? '—'}
                        </td>
                        <td className="px-3 py-2"><Chip severity={entry.severity} /></td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setOpen(expanded ? null : id)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-paper"
                            aria-expanded={expanded}
                          >
                            {expanded ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            {expanded ? 'Hide' : 'Detail'}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-t border-slate-100 bg-white">
                          <td colSpan={7} className="px-3 py-3"><Detail entry={entry} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.pages > 1 && (
          <div className="flex items-center justify-between border-t border-line p-3 text-sm text-ink-soft">
            <span>
              Page {meta.page} of {meta.pages} · {meta.total} entries
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={meta.page <= 1}
                onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}
                className="inline-flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>
              <button
                type="button"
                disabled={meta.page >= meta.pages}
                onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}
                className="inline-flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 disabled:opacity-40"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

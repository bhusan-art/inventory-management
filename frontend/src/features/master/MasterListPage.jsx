import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermissions } from '../../hooks/usePermission.js';
import DataTable from '../../components/table/DataTable.jsx';
import { MASTER_CONFIGS } from './masterConfig.js';

/** Waits until typing pauses, so a six-letter search is one request, not six. */
function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export default function MasterListPage({ entity }) {
  const params = useParams();
  const key = entity ?? params.entity;
  const config = MASTER_CONFIGS[key];

  const permissions = usePermissions();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ rows: [], meta: null, loading: true, error: null });

  const debouncedSearch = useDebounced(search);

  // Columns the actor cannot read are dropped, not rendered empty.
  const columns = useMemo(
    () => (config?.columns ?? []).filter((c) => !c.permission || permissions.has(c.permission)),
    [config, permissions],
  );

  useEffect(() => { setPage(1); }, [debouncedSearch, key]);

  // Belt and braces alongside the route key: never render rows fetched for a
  // different entity against this entity's columns.
  useEffect(() => {
    setState({ rows: [], meta: null, loading: true, error: null });
    setSearch('');
  }, [key]);

  useEffect(() => {
    if (!config) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    api.get(`/${config.endpoint}`, { params: { page, limit: 25, search: debouncedSearch || undefined } })
      .then((res) => {
        if (cancelled) return;
        setState({ rows: res.data.data, meta: res.data.meta, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ rows: [], meta: null, loading: false, error: toMessage(err, 'Could not load records') });
      });

    return () => { cancelled = true; };
  }, [config, page, debouncedSearch]);

  if (!config) {
    return <p className="text-sm text-slate-600">Unknown section.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{config.title}</h1>
          {state.meta && (
            <p className="text-sm text-slate-500">{state.meta.total} record{state.meta.total === 1 ? '' : 's'}</p>
          )}
        </div>

        {config.searchable !== false && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={config.searchPlaceholder ?? 'Search…'}
            className="w-72 rounded border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={state.rows}
        meta={state.meta}
        loading={state.loading}
        error={state.error}
        onPageChange={setPage}
        emptyMessage={search ? 'No records match that search' : `No ${config.title.toLowerCase()} yet`}
      />
    </div>
  );
}

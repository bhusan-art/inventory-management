import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermissions } from '../../hooks/usePermission.js';
import DataTable from '../../components/table/DataTable.jsx';
import EntityForm from '../../components/form/EntityForm.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
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
  // `editing` is null when closed, 'new' for a create, or the record itself.
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((n) => n + 1);

  const debouncedSearch = useDebounced(search);

  // Columns the actor cannot read are dropped, not rendered empty.
  const columns = useMemo(
    () => (config?.columns ?? []).filter((c) => !c.permission || permissions.has(c.permission)),
    [config, permissions],
  );

  const canEdit = Boolean(config?.fields?.length) && permissions.has(config?.permissions?.update);
  const canDelete = permissions.has(config?.permissions?.remove);

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
  }, [config, page, debouncedSearch, reloadToken]);

  if (!config) {
    return <p className="text-sm text-ink-soft">Unknown section.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{config.title}</h1>
          {state.meta && (
            <p className="text-sm text-ink-muted">{state.meta.total} record{state.meta.total === 1 ? '' : 's'}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
        {/* A screen may offer one action in its header. Gated by permission so
            the button is never offered to someone the API would refuse. */}
        {/* A screen gets a create button only if it has fields describing the
            form AND the actor holds the permission. The second half is a
            courtesy; the API refuses regardless. */}
        {config.fields?.length > 0 && permissions.has(config.permissions.create) && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> New
          </button>
        )}
        {config.headerAction && permissions.has(config.headerAction.permission) && (
          <Link
            to={config.headerAction.to}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> {config.headerAction.label}
          </Link>
        )}
        {config.searchable !== false && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={config.searchPlaceholder ?? 'Search…'}
            className="w-72 rounded-control border border-line-strong py-2 pl-8 pr-3 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        )}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={state.rows}
        meta={state.meta}
        loading={state.loading}
        error={state.error}
        rowLink={config.rowLink}
        onPageChange={setPage}
        emptyMessage={search ? 'No records match that search' : `No ${config.title.toLowerCase()} yet`}
        rowActions={canEdit || canDelete ? (row) => (
          <div className="flex justify-end gap-1">
            {canEdit && (
              <button
                type="button" aria-label={`Edit ${row.name ?? row.vendorName ?? row.customerName ?? ''}`}
                onClick={() => setEditing(row)}
                className="rounded p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            {canDelete && (
              <button
                type="button" aria-label={`Delete ${row.name ?? row.vendorName ?? row.customerName ?? ''}`}
                onClick={() => setDeleting(row)}
                className="rounded p-1.5 text-ink-muted hover:bg-rose-50 hover:text-rose-700"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ) : undefined}
      />

      {editing && (
        <EntityForm
          fields={config.fields}
          record={editing === 'new' ? null : editing}
          endpoint={config.endpoint}
          title={editing === 'new' ? `New ${singular(config.title)}` : `Edit ${singular(config.title)}`}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${singular(config.title).toLowerCase()}?`}
          /* The API soft-deletes, so this is recoverable in the database — but
             the record vanishes from every screen, and saying "permanently"
             would be a lie while saying nothing invites a casual click. */
          body={`${deleting.name ?? deleting.vendorName ?? deleting.customerName ?? 'This record'} will no longer appear anywhere in the system. Records that already reference it keep their history.`}
          confirmLabel="Delete"
          destructive
          endpoint={`/${config.endpoint}/${deleting.id}`}
          onClose={() => setDeleting(null)}
          onDone={() => { setDeleting(null); reload(); }}
        />
      )}
    </div>
  );
}

/** "Products" → "Product". Good enough for the titles this app has. */
function singular(title) {
  if (title.endsWith('ies')) return `${title.slice(0, -3)}y`;
  if (title.endsWith('s')) return title.slice(0, -1);
  return title;
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserCheck, UserX,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermissions, useSession } from '../../hooks/usePermission.js';
import DataTable from '../../components/table/DataTable.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import UserFormDialog from './UserFormDialog.jsx';
import UserPermissionsDialog from './UserPermissionsDialog.jsx';

/**
 * Staff accounts.
 *
 * A dedicated screen rather than the generic master list, because a user is
 * not a record with fields — it is an identity with a role, a set of
 * exceptions to that role, a warehouse scope and a status, each changed
 * through its own endpoint. Cramming that into one PUT would mean the server
 * could not tell "promote this person" from "correct their surname", and the
 * audit trail is the poorer for it.
 *
 * Deliberately no customer logins here. Customers in this system are records
 * you ship to, not people who sign in — that would need a second identity
 * type, its own authentication and a portal, and none of it exists.
 */
export default function UsersPage() {
  const permissions = usePermissions();
  const session = useSession();

  const canCreate = permissions.has('CREATE_USER');
  const canUpdate = permissions.has('UPDATE_USER');
  const canDelete = permissions.has('DELETE_USER');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ rows: [], meta: null, loading: true, error: null });
  const [editing, setEditing] = useState(null);
  const [permissionsFor, setPermissionsFor] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [newPassword, setNewPassword] = useState(null);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get('/users', { params: { page, limit: 25, search: search || undefined } })
      .then((res) => setState({ rows: res.data.data, meta: res.data.meta, loading: false, error: null }))
      .catch((err) => setState({
        rows: [], meta: null, loading: false, error: toMessage(err, 'Could not load users'),
      }));
  }, [page, search]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const columns = useMemo(() => [
    { key: 'fullName', label: 'Name' },
    { key: 'email', label: 'Email', mono: true },
    { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
    { key: 'role', label: 'Role', render: (r) => r.role?.name ?? '—' },
    {
      key: 'scope',
      label: 'Warehouses',
      // "All" is the meaningful answer for an empty scope, not a dash: an
      // empty warehouse list means unrestricted, which is the opposite of
      // what a blank cell suggests.
      render: (r) => (r.scope?.warehouseIds?.length
        ? `${r.scope.warehouseIds.length} assigned`
        : 'All'),
    },
    {
      key: 'lastLoginAt',
      label: 'Last sign-in',
      render: (r) => (r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleDateString() : 'Never'),
    },
    { key: 'status', label: 'Status', status: true },
  ].filter((c) => !c.permission || permissions.has(c.permission)), [permissions]);

  const setStatus = async (user, status) => {
    try {
      await api.patch(`/users/${user.id}/status`, { status });
      load();
    } catch (err) {
      setState((s) => ({ ...s, error: toMessage(err, 'Could not change that status') }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Users</h1>
          {state.meta && (
            <p className="text-sm text-ink-muted">{state.meta.total} account{state.meta.total === 1 ? '' : 's'}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button" onClick={() => setEditing('new')}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> New user
            </button>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" />
            <input
              value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by name or email…"
              className="w-64 rounded-control border border-line-strong py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>
      </div>

      {newPassword && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-sm font-medium text-emerald-900">
            Temporary password for {newPassword.email}
          </p>
          <p className="mt-1 font-mono text-lg text-emerald-900">{newPassword.password}</p>
          {/* Shown once and never stored in a readable form. Saying so stops
              someone closing this expecting to find it again later. */}
          <p className="mt-1 text-xs text-emerald-800">
            Shown once — copy it now. They must change it at first sign-in.
          </p>
          <button
            type="button" onClick={() => setNewPassword(null)}
            className="mt-2 text-xs text-emerald-900 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={state.rows}
        meta={state.meta}
        loading={state.loading}
        error={state.error}
        onPageChange={setPage}
        emptyMessage={search ? 'No users match that search' : 'No users yet'}
        rowActions={(row) => {
          // Acting on yourself is how people lock themselves out. The server
          // refuses it; hiding the buttons avoids finding that out the hard way.
          const isSelf = row.id === session?.userId;
          return (
            <div className="flex justify-end gap-1">
              {canUpdate && (
                <button
                  type="button" aria-label={`Edit ${row.fullName}`} onClick={() => setEditing(row)}
                  className="rounded p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              {canUpdate && (
                <button
                  type="button" aria-label={`Permissions for ${row.fullName}`}
                  onClick={() => setPermissionsFor(row)}
                  className="rounded p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
                >
                  <ShieldCheck className="h-4 w-4" />
                </button>
              )}
              {canUpdate && !isSelf && (
                <button
                  type="button"
                  aria-label={row.status === 'ACTIVE' ? `Deactivate ${row.fullName}` : `Activate ${row.fullName}`}
                  onClick={() => setStatus(row, row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')}
                  className="rounded p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
                >
                  {row.status === 'ACTIVE' ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                </button>
              )}
              {canUpdate && (
                <button
                  type="button" aria-label={`Reset password for ${row.fullName}`}
                  onClick={() => setConfirming({ kind: 'reset', row })}
                  className="rounded p-1.5 text-ink-muted hover:bg-paper hover:text-ink"
                >
                  <KeyRound className="h-4 w-4" />
                </button>
              )}
              {canDelete && !isSelf && (
                <button
                  type="button" aria-label={`Delete ${row.fullName}`}
                  onClick={() => setConfirming({ kind: 'delete', row })}
                  className="rounded p-1.5 text-ink-muted hover:bg-rose-50 hover:text-rose-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          );
        }}
      />

      {editing && (
        <UserFormDialog
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            // The create endpoint answers { user, temporaryPassword } — the
            // email is on `user`, not on the envelope.
            if (saved?.temporaryPassword) {
              setNewPassword({ email: saved.user?.email ?? '', password: saved.temporaryPassword });
            }
            load();
          }}
        />
      )}

      {permissionsFor && (
        <UserPermissionsDialog
          user={permissionsFor}
          onClose={() => setPermissionsFor(null)}
          onSaved={() => { setPermissionsFor(null); load(); }}
        />
      )}

      {confirming?.kind === 'reset' && (
        <ConfirmDialog
          title={`Reset the password for ${confirming.row.fullName}?`}
          body="They are signed out of every session and must set a new password at next sign-in. The temporary one is shown once."
          confirmLabel="Reset password"
          method="post"
          endpoint={`/users/${confirming.row.id}/reset-password`}
          onClose={() => setConfirming(null)}
          onDone={(result) => {
            setConfirming(null);
            if (result?.temporaryPassword) {
              setNewPassword({ email: confirming.row.email, password: result.temporaryPassword });
            }
            load();
          }}
        />
      )}

      {confirming?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${confirming.row.fullName}?`}
          body="The account can no longer sign in. Everything they did keeps their name on it — the audit trail stores the name, not a link, so history does not change."
          confirmLabel="Delete user"
          destructive
          endpoint={`/users/${confirming.row.id}`}
          onClose={() => setConfirming(null)}
          onDone={() => { setConfirming(null); load(); }}
        />
      )}
    </div>
  );
}

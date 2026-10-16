import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Minus, Plus, X } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';

/**
 * Per-user exceptions to a role.
 *
 * The resolver is `role ∪ grants − denies`, and this screen shows all three
 * at once rather than a flat list of ticks. A flat list cannot express the
 * difference between "has it because of the role" and "has it because someone
 * granted it specifically", and that difference is the whole point: changing
 * the role changes the first and not the second.
 *
 * A DENY beats a grant. Shown explicitly, because the alternative is someone
 * adding a grant, seeing no effect, and concluding the system is broken.
 *
 * Exceptions should be rare. If several people need the same deviation, the
 * honest fix is a role — the note says so, because a permission system that
 * drifts into per-person configuration stops being auditable.
 */
export default function UserPermissionsDialog({ user, onClose, onSaved }) {
  const [catalogue, setCatalogue] = useState({});
  const [grants, setGrants] = useState(user.permissionGrants ?? []);
  const [denies, setDenies] = useState(user.permissionDenies ?? []);
  const [rolePermissions, setRolePermissions] = useState([]);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // The endpoint answers { modules: { PRODUCT: [...], ... }, total } — it
    // groups for us. Flattening and regrouping here would be a second,
    // disagreeing idea of which module a permission belongs to.
    api.get('/permissions')
      .then((res) => setCatalogue(res.data.data?.modules ?? {}))
      // Listing permissions needs VIEW_ROLE, which someone with UPDATE_USER
      // may not hold. Say so rather than showing an empty screen.
      .catch(() => setMessage('Could not load the permission list — this needs the VIEW_ROLE permission.'));

    if (user.role?.id) {
      api.get(`/roles/${user.role.id}`)
        .then((res) => setRolePermissions(res.data.data?.permissions ?? []))
        .catch(() => setRolePermissions([]));
    }
  }, [user.role?.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const roleSet = useMemo(() => new Set(rolePermissions), [rolePermissions]);

  const grouped = useMemo(() => {
    const term = filter.trim().toUpperCase();
    const out = {};
    for (const [module, items] of Object.entries(catalogue)) {
      const kept = items.filter((p) => !term
        || p.code.includes(term)
        || String(p.label ?? '').toUpperCase().includes(term));
      if (kept.length > 0) out[module] = kept;
    }
    return out;
  }, [catalogue, filter]);

  const stateOf = (code) => {
    if (denies.includes(code)) return 'denied';
    if (grants.includes(code)) return 'granted';
    if (roleSet.has(code)) return 'role';
    return 'none';
  };

  /** Cycles: role/none → granted → denied → back. */
  const cycle = (code) => {
    const current = stateOf(code);
    setGrants((g) => g.filter((c) => c !== code));
    setDenies((d) => d.filter((c) => c !== code));
    if (current === 'none' || current === 'role') setGrants((g) => [...g, code]);
    else if (current === 'granted') setDenies((d) => [...d, code]);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.patch(`/users/${user.id}/permissions`, {
        permissionGrants: grants,
        permissionDenies: denies,
      });
      onSaved();
    } catch (err) {
      setMessage(toMessage(err, 'Could not save those permissions'));
      setSaving(false);
    }
  };

  const CHIP = {
    role: 'bg-slate-100 text-ink-soft ring-slate-200',
    granted: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
    denied: 'bg-rose-100 text-rose-800 ring-rose-300',
    none: 'bg-white text-ink-muted ring-slate-200',
  };
  const LABEL = { role: 'From role', granted: 'Granted', denied: 'Denied', none: 'No' };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="w-full max-w-3xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-ink">
              Permissions for {user.fullName}
            </h2>
            <p className="text-xs text-ink-muted">
              Role {user.role?.name ?? '—'} · {grants.length} granted · {denies.length} denied
            </p>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="rounded-md p-1 text-ink-muted hover:bg-paper hover:text-ink-soft"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          {message && (
            <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
            </div>
          )}

          <p className="rounded-md bg-paper p-3 text-xs text-ink-soft">
            Click a permission to cycle it: <strong>from role</strong> →{' '}
            <strong className="text-emerald-800">granted</strong> →{' '}
            <strong className="text-rose-800">denied</strong>. A denial always wins.
            If several people need the same exception, change the role instead —
            per-person settings are hard to audit.
          </p>

          <input
            value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter permissions…"
            className="w-full rounded-control border border-line-strong px-3 py-2 text-sm"
          />

          {Object.entries(grouped).sort().map(([module, items]) => (
            <section key={module}>
              <h3 className="mb-1.5 text-xs font-medium text-ink-muted">
                {module.replace(/_/g, ' ')}
              </h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {items.map((p) => {
                  const state = stateOf(p.code);
                  return (
                    <button
                      key={p.code} type="button" onClick={() => cycle(p.code)}
                      className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ring-1 ring-inset hover:brightness-95 ${CHIP[state]}`}
                      title={p.label ?? p.code}
                    >
                      <span className="truncate font-mono">{p.code}</span>
                      <span className="flex shrink-0 items-center gap-1 font-medium">
                        {state === 'granted' && <Plus className="h-3 w-3" />}
                        {state === 'denied' && <Minus className="h-3 w-3" />}
                        {LABEL[state]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {Object.keys(catalogue).length === 0 && !message && (
            <p className="text-sm text-ink-muted">Loading permissions…</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => { setGrants([]); setDenies([]); }}
            className="text-xs text-ink-soft underline"
          >
            Clear all exceptions
          </button>
          <div className="flex gap-2">
            <button
              type="button" onClick={onClose} disabled={saving}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button" onClick={save} disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save exceptions
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

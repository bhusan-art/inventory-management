import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';

/**
 * Creating and editing a staff account.
 *
 * Create and update take DIFFERENT fields, and the dialog reflects that rather
 * than showing everything and hoping. Email cannot change after creation — it
 * is the sign-in identity, and the update endpoint does not accept it — so on
 * an edit it is shown read-only instead of as a box that silently discards
 * what you type.
 *
 * Warehouse scope is set on its own endpoint and only on an edit, because it
 * is a different decision from "who is this person": an empty list means
 * unrestricted, which is a thing to choose deliberately rather than inherit
 * from a form default.
 */
export default function UserFormDialog({ user, onClose, onSaved }) {
  const isEdit = Boolean(user);

  const [roles, setRoles] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [form, setForm] = useState({
    fullName: user?.fullName ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    role: user?.role?.id ?? '',
    department: user?.department ?? '',
    sessionProfile: user?.sessionProfile ?? 'STANDARD',
    warehouseIds: user?.scope?.warehouseIds ?? [],
  });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/roles', { params: { limit: 100 } }).catch(() => ({ data: { data: [] } })),
      api.get('/warehouses', { params: { limit: 200, status: 'ACTIVE' } }).catch(() => ({ data: { data: [] } })),
    ]).then(([r, w]) => { setRoles(r.data.data); setWarehouses(w.data.data); });
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const set = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const toggleWarehouse = (id) => setForm((f) => ({
    ...f,
    warehouseIds: f.warehouseIds.includes(id)
      ? f.warehouseIds.filter((w) => w !== id)
      : [...f.warehouseIds, id],
  }));

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    const missing = {};
    if (!form.fullName.trim()) missing.fullName = 'Required';
    if (!isEdit && !form.email.trim()) missing.email = 'Required';
    if (!form.role) missing.role = 'Required';
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setMessage('Fill in the highlighted fields.');
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        const saved = await api.put(`/users/${user.id}`, {
          fullName: form.fullName.trim(),
          phone: form.phone.trim() || null,
          role: form.role,
          department: form.department.trim() || null,
          sessionProfile: form.sessionProfile,
        });
        // Scope has its own endpoint. Sent second, and only when it changed,
        // so a failure here does not look like the whole edit failing.
        const before = [...(user.scope?.warehouseIds ?? [])].sort().join();
        if (before !== [...form.warehouseIds].sort().join()) {
          await api.patch(`/users/${user.id}/scope`, { warehouseIds: form.warehouseIds });
        }
        onSaved(saved.data.data);
      } else {
        const saved = await api.post('/users', {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          role: form.role,
          department: form.department.trim() || undefined,
          sessionProfile: form.sessionProfile,
          scope: { warehouseIds: form.warehouseIds },
        });
        onSaved(saved.data.data);
      }
    } catch (err) {
      setErrors(fieldErrors(err));
      setMessage(toMessage(err, 'Could not save this user'));
      setSaving(false);
    }
  };

  const input = 'w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900/10';
  const border = (f) => (errors[f] ? 'border-rose-400 bg-rose-50/40' : 'border-line-strong');

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">
            {isEdit ? `Edit ${user.fullName}` : 'New user'}
          </h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="rounded-md p-1 text-ink-muted hover:bg-paper hover:text-ink-soft"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
            {message && (
              <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">
                  Full name <span className="text-rose-600">*</span>
                </span>
                <input
                  value={form.fullName} maxLength={120} className={`${input} ${border('fullName')}`}
                  onChange={(e) => set('fullName', e.target.value)}
                />
                {errors.fullName && <span className="mt-1 block text-xs text-rose-700">{errors.fullName}</span>}
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">
                  Email <span className="text-rose-600">*</span>
                </span>
                <input
                  type="email" value={form.email} disabled={isEdit}
                  className={`${input} ${border('email')} disabled:bg-paper disabled:text-ink-muted`}
                  onChange={(e) => set('email', e.target.value)}
                />
                {isEdit && (
                  <span className="mt-1 block text-xs text-ink-muted">
                    This is the sign-in identity and cannot be changed.
                  </span>
                )}
                {errors.email && <span className="mt-1 block text-xs text-rose-700">{errors.email}</span>}
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">Phone</span>
                <input
                  value={form.phone} maxLength={20} className={`${input} ${border('phone')}`}
                  onChange={(e) => set('phone', e.target.value)}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">
                  Role <span className="text-rose-600">*</span>
                </span>
                <select
                  value={form.role} className={`${input} ${border('role')} bg-white`}
                  onChange={(e) => set('role', e.target.value)}
                >
                  <option value="">—</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {/* The server refuses a role at or above the creator's own
                    rank, so the list may legitimately be shorter than the
                    full set of roles. */}
                <span className="mt-1 block text-xs text-ink-muted">
                  You can only assign a role below your own.
                </span>
                {errors.role && <span className="mt-1 block text-xs text-rose-700">{errors.role}</span>}
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">Department</span>
                <input
                  value={form.department} maxLength={80} className={`${input} ${border('department')}`}
                  onChange={(e) => set('department', e.target.value)}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-ink-soft">Session type</span>
                <select
                  value={form.sessionProfile} className={`${input} border-line-strong bg-white`}
                  onChange={(e) => set('sessionProfile', e.target.value)}
                >
                  <option value="STANDARD">Standard</option>
                  <option value="KIOSK">Kiosk — long-lived session for a shared terminal</option>
                </select>
              </label>
            </div>

            <fieldset className="rounded-md border border-line p-3">
              <legend className="px-1 text-xs font-medium text-ink-soft">
                Warehouse access
              </legend>
              <p className="mb-2 text-xs text-ink-muted">
                {form.warehouseIds.length === 0
                  ? 'None selected — this user can see every warehouse.'
                  : `Restricted to ${form.warehouseIds.length} warehouse(s).`}
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {warehouses.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox" checked={form.warehouseIds.includes(w.id)}
                      onChange={() => toggleWarehouse(w.id)}
                      className="h-4 w-4 rounded border-line-strong"
                    />
                    <span className="font-mono text-xs text-ink-muted">{w.code}</span>
                    <span className="text-ink-soft">{w.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {!isEdit && (
              <p className="rounded-md bg-paper p-3 text-xs text-ink-soft">
                A temporary password is generated and shown once after saving.
                The account must change it at first sign-in.
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button" onClick={onClose} disabled={saving}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEdit ? 'Save changes' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

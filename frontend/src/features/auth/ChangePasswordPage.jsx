import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate } from 'react-router-dom';
import { changePassword } from './authSlice.js';

/**
 * Forced password change for seeded and reset accounts.
 *
 * Reachable while authenticated but before the rest of the app: a temporary
 * password handed over by an administrator should not be usable indefinitely.
 */
export default function ChangePasswordPage() {
  const dispatch = useDispatch();
  const { session, status, error } = useSelector((s) => s.auth);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [localError, setLocalError] = useState(null);
  const [done, setDone] = useState(false);

  if (status !== 'authenticated' && !done) return <Navigate to="/login" replace />;
  if (done) return <Navigate to="/login" replace />;

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setLocalError(null);

    if (form.newPassword !== form.confirm) {
      setLocalError('The two passwords do not match');
      return;
    }

    const result = await dispatch(changePassword({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword,
    }));

    if (changePassword.fulfilled.match(result)) setDone(true);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-panel border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-ink">Change your password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {session?.mustChangePassword
            ? 'This account still uses a temporary password.'
            : 'Choose a new password.'}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {[
            ['currentPassword', 'Current password', 'current-password'],
            ['newPassword', 'New password', 'new-password'],
            ['confirm', 'Confirm new password', 'new-password'],
          ].map(([field, label, autoComplete]) => (
            <div key={field}>
              <label htmlFor={field} className="block text-sm font-medium text-ink-soft">{label}</label>
              <input
                id={field}
                type="password"
                autoComplete={autoComplete}
                required
                value={form[field]}
                onChange={update(field)}
                className="mt-1 w-full rounded-control border border-line-strong px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
          ))}

          <p className="text-xs text-ink-muted">At least 12 characters, including letters and numbers.</p>

          {(localError || error) && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {localError ?? error}
            </div>
          )}

          <button
            type="submit"
            className="w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Change password
          </button>
          <p className="text-center text-xs text-ink-muted">
            You will be signed out of all devices afterwards.
          </p>
        </form>
      </div>
    </div>
  );
}

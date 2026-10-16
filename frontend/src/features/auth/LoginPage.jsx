import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate } from 'react-router-dom';
import { LogIn, AlertCircle } from 'lucide-react';
import { login, clearError } from './authSlice.js';

export default function LoginPage() {
  const dispatch = useDispatch();
  const { status, error, session } = useSelector((s) => s.auth);
  const [form, setForm] = useState({ email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated') {
    return <Navigate to={session?.mustChangePassword ? '/change-password' : '/'} replace />;
  }

  const update = (field) => (e) => {
    if (error) dispatch(clearError());
    setForm((f) => ({ ...f, [field]: e.target.value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    await dispatch(login(form));
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-panel border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">Inventory Management System</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-soft">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={update('email')}
              className="mt-1 w-full rounded-control border border-line-strong px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink-soft">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={update('password')}
              className="mt-1 w-full rounded-control border border-line-strong px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {/* The server returns one message for every credential failure;
                  the UI must not elaborate on it. */}
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            <LogIn className="h-4 w-4" />
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

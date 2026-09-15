import { useEffect, useState } from 'react';

/**
 * Phase 0 placeholder. Its only job is to prove the frontend container builds,
 * the dev proxy reaches the API, and the health contract is honoured
 * end-to-end. Phase 1 replaces this with the router, store and login screen.
 */
export default function App() {
  const [state, setState] = useState({ status: 'checking', detail: null });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/health/ready')
      .then(async (res) => ({ ok: res.ok, body: await res.json() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        setState({ status: ok ? 'ready' : 'degraded', detail: body.data?.checks ?? null });
      })
      .catch((err) => !cancelled && setState({ status: 'unreachable', detail: err.message }));
    return () => {
      cancelled = true;
    };
  }, []);

  const tone = {
    checking: 'text-slate-500',
    ready: 'text-emerald-600',
    degraded: 'text-amber-600',
    unreachable: 'text-red-600',
  }[state.status];

  return (
    <main className="flex h-full items-center justify-center bg-slate-50 p-8">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Inventory Management System</h1>
        <p className="mt-1 text-sm text-slate-500">Phase 0 — foundation</p>

        <p className={`mt-6 text-sm font-medium ${tone}`}>API status: {state.status}</p>

        {state.detail && (
          <pre className="mt-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
            {JSON.stringify(state.detail, null, 2)}
          </pre>
        )}
      </div>
    </main>
  );
}

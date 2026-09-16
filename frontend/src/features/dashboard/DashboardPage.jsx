import { useDispatch } from 'react-redux';
import { LogOut, ShieldCheck } from 'lucide-react';
import { logout } from '../auth/authSlice.js';
import { useSession, usePermissions } from '../../hooks/usePermission.js';
import PermissionGuard from '../../components/PermissionGuard.jsx';

/**
 * Phase 1 landing page.
 *
 * Deliberately shows the actor's effective permission set. During the phases
 * that follow, being able to see exactly what a role resolves to — after
 * grants and denies — is the fastest way to confirm the matrix is behaving.
 * Phase 10 replaces this with the real dashboard.
 */
export default function DashboardPage() {
  const dispatch = useDispatch();
  const session = useSession();
  const permissions = usePermissions();

  const grouped = [...permissions].sort().reduce((acc, code) => {
    const module = code.split('_').slice(1).join('_') || 'GENERAL';
    (acc[module] ??= []).push(code);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Inventory Management System</h1>
            <p className="text-xs text-slate-500">Phase 1 — authentication and access control</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-medium text-slate-900">{session?.fullName}</p>
              <p className="text-xs text-slate-500">{session?.role?.name}</p>
            </div>
            <button
              onClick={() => dispatch(logout())}
              className="flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-600" />
            <h2 className="font-medium text-slate-900">Effective permissions</h2>
            <span className="ml-auto text-sm text-slate-500">{permissions.size} granted</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Resolved as role ∪ grants − denies. Warehouse scope:{' '}
            {session?.scope?.hasGlobalWarehouseScope
              ? 'all warehouses'
              : `${session?.scope?.warehouseIds?.length ?? 0} assigned`}
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(grouped).map(([module, codes]) => (
              <div key={module} className="rounded border border-slate-200 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{module}</p>
                <ul className="mt-2 space-y-1">
                  {codes.map((c) => (
                    <li key={c} className="font-mono text-xs text-slate-700">{c}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Demonstrates the guard: this card is absent, not disabled, for roles
            without the permission. */}
        <PermissionGuard
          permission="MANAGE_SUPER_ADMIN"
          fallback={
            <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500">
              Administrator tools are not available to your role.
            </div>
          }
        >
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
            <p className="text-sm font-medium text-amber-900">Super Admin tools</p>
            <p className="mt-1 text-sm text-amber-800">
              You can manage other administrators and security-critical settings.
            </p>
          </div>
        </PermissionGuard>
      </main>
    </div>
  );
}

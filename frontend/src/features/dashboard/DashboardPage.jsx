import { ShieldCheck } from 'lucide-react';
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
  const session = useSession();
  const permissions = usePermissions();

  const grouped = [...permissions].sort().reduce((acc, code) => {
    const module = code.split('_').slice(1).join('_') || 'GENERAL';
    (acc[module] ??= []).push(code);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
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
    </div>
  );
}

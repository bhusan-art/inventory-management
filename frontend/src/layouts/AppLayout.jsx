import { NavLink, Outlet } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { LogOut } from 'lucide-react';
import { logout } from '../features/auth/authSlice.js';
import { useSession, usePermissions } from '../hooks/usePermission.js';
import { visibleNavigation } from '../constants/navigation.js';

export default function AppLayout() {
  const dispatch = useDispatch();
  const session = useSession();
  const permissions = usePermissions();
  const nav = visibleNavigation(permissions);

  const linkClass = ({ isActive }) =>
    `flex items-center gap-2.5 rounded px-3 py-2 text-sm ${
      isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Inventory</p>
          <p className="text-xs text-slate-500">Management System</p>
        </div>

        <nav className="space-y-4 p-3">
          {nav.map((entry) =>
            entry.section ? (
              <div key={entry.section}>
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {entry.section}
                </p>
                <div className="space-y-0.5">
                  {entry.items.map((item) => (
                    <NavLink key={item.to} to={item.to} className={linkClass}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ) : (
              <NavLink key={entry.to} to={entry.to} end className={linkClass}>
                <entry.icon className="h-4 w-4" />
                {entry.label}
              </NavLink>
            ),
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          {/* Small screens lose the sidebar, so the links move inline — the
              warehouse screens are the ones actually used on a phone. */}
          <nav className="flex gap-3 overflow-x-auto lg:hidden">
            {nav.flatMap((e) => (e.section ? e.items : [e])).map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className="whitespace-nowrap text-sm text-slate-600">
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
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
        </header>

        <main className="flex-1 p-6"><Outlet /></main>
      </div>
    </div>
  );
}

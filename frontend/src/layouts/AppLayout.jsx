import { NavLink, Outlet } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { LogOut } from 'lucide-react';
import { logout } from '../features/auth/authSlice.js';
import { useSession, usePermissions } from '../hooks/usePermission.js';
import { visibleNavigation } from '../constants/navigation.js';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import NotificationBell from '../components/NotificationBell.jsx';
import ScanBar from '../components/ScanBar.jsx';

/**
 * The shell.
 *
 * `h-screen` + `overflow-hidden`, not `min-h-screen`. With min-h-screen the
 * whole document scrolls, so the sidebar and the header — Sign out included —
 * slide away the moment a list is longer than the window. Pinning the shell to
 * the viewport and letting only <main> scroll keeps navigation where the eye
 * expects it, which matters most on exactly the long screens where scrolling
 * happens.
 *
 * The sidebar is dark and everything else is quiet. One strong move: it gives
 * the application a spine, separates chrome from work, and means the content
 * area needs no shadows or boxes to read as the thing you are doing.
 */
export default function AppLayout() {
  const dispatch = useDispatch();
  const session = useSession();
  const permissions = usePermissions();
  const nav = visibleNavigation(permissions);

  const linkClass = ({ isActive }) =>
    `flex items-center gap-2.5 rounded-control px-3 py-[7px] text-[13px] transition-colors ${
      isActive
        ? 'bg-white/10 font-medium text-white'
        : 'text-white/65 hover:bg-white/[0.06] hover:text-white'
    }`;

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <aside className="hidden w-[232px] shrink-0 flex-col bg-ink lg:flex">
        <div className="px-5 py-5">
          <p className="text-[15px] font-semibold leading-tight text-white">Inventory</p>
          <p className="mt-0.5 text-xs text-white/45">Scorigx Innovations</p>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
          {nav.map((entry) =>
            entry.section ? (
              <div key={entry.section}>
                {/* Sentence case, not tracked-out capitals. A section heading
                    is a signpost, not a graphic device. */}
                <p className="px-3 pb-1.5 text-xs font-medium text-white/35">
                  {entry.section}
                </p>
                <div className="space-y-px">
                  {entry.items.map((item) => (
                    <NavLink key={item.to} to={item.to} className={linkClass}>
                      <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ) : (
              <NavLink key={entry.to} to={entry.to} end className={linkClass}>
                <entry.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {entry.label}
              </NavLink>
            ),
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-6 py-2.5">
          {/* Small screens lose the sidebar, so the links move inline — the
              warehouse screens are the ones actually used on a phone. */}
          <nav className="flex gap-4 overflow-x-auto lg:hidden">
            {nav.flatMap((e) => (e.section ? e.items : [e])).map((item) => (
              <NavLink
                key={item.to} to={item.to} end={item.to === '/'}
                className="whitespace-nowrap text-[13px] text-ink-soft"
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <ScanBar />
            <NotificationBell />
            <div className="hidden text-right sm:block">
              <p className="text-[13px] font-medium leading-tight text-ink">{session?.fullName}</p>
              <p className="text-xs text-ink-muted">{session?.role?.name}</p>
            </div>
            <button
              type="button"
              onClick={() => dispatch(logout())}
              className="flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-[13px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        {/* Scoped to the content area: a crash inside a page leaves the
            sidebar and sign-out button usable, so the user is not stranded. */}
        <main className="flex-1 overflow-y-auto px-6 py-5">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

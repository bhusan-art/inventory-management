import { Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import LoginPage from '../features/auth/LoginPage.jsx';
import ChangePasswordPage from '../features/auth/ChangePasswordPage.jsx';
import DashboardPage from '../features/dashboard/DashboardPage.jsx';
import AppLayout from '../layouts/AppLayout.jsx';
import MasterListPage from '../features/master/MasterListPage.jsx';
import { MASTER_CONFIGS } from '../features/master/masterConfig.js';

/**
 * Route protection.
 *
 * `permission` gates a route the same way PermissionGuard gates a subtree —
 * and with the same caveat: this is presentation. The API refuses the request
 * regardless of whether the route rendered.
 */
function Protected({ permission, children }) {
  const { status, session, permissions } = useSelector((s) => s.auth);

  if (status === 'restoring' || status === 'idle') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (status !== 'authenticated') return <Navigate to="/login" replace />;

  // A temporary password must be replaced before anything else is reachable.
  if (session?.mustChangePassword) return <Navigate to="/change-password" replace />;

  if (permission && !permissions.includes(permission)) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-slate-600">
        You do not have permission to view this page.
      </div>
    );
  }

  return children;
}

/** Page-level guard for routes nested inside the authenticated layout. */
function RequirePermission({ permission, children }) {
  const { permissions } = useSelector((s) => s.auth);
  if (permission && !permissions.includes(permission)) {
    return (
      <p className="text-sm text-slate-600">You do not have permission to view this page.</p>
    );
  }
  return children;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route element={<Protected><AppLayout /></Protected>}>
        <Route path="/" element={<DashboardPage />} />
        {/* One route per master entity, generated from the same config that
            drives the sidebar and the columns. */}
        {Object.entries(MASTER_CONFIGS).map(([key, config]) => (
          <Route
            key={key}
            path={`/${key}`}
            element={
              <RequirePermission permission={config.permissions.view}>
                {/*
                  The key is load-bearing. Every one of these routes renders the
                  same component type at the same position, so React reconciles
                  them as "the same element with new props" and keeps the state —
                  including rows loaded for the previous entity. Changing the key
                  forces an unmount and a clean mount, which is what a page
                  refresh does and why a refresh "fixed" it.
                */}
                <MasterListPage key={key} entity={key} />
              </RequirePermission>
            }
          />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

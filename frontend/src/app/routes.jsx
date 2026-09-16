import { Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import LoginPage from '../features/auth/LoginPage.jsx';
import ChangePasswordPage from '../features/auth/ChangePasswordPage.jsx';
import DashboardPage from '../features/dashboard/DashboardPage.jsx';

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

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/" element={<Protected><DashboardPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

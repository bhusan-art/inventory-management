import { Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import LoginPage from '../features/auth/LoginPage.jsx';
import ChangePasswordPage from '../features/auth/ChangePasswordPage.jsx';
import DashboardPage from '../features/dashboard/DashboardPage.jsx';
import AppLayout from '../layouts/AppLayout.jsx';
import MasterListPage from '../features/master/MasterListPage.jsx';
import SerialDetailPage from '../features/serials/SerialDetailPage.jsx';
import ServiceRequestDetailPage from '../features/service/ServiceRequestDetailPage.jsx';
import NewServiceRequestPage from '../features/service/NewServiceRequestPage.jsx';
import CustomerReturnDetailPage from '../features/returns/CustomerReturnDetailPage.jsx';
import ReportsPage from '../features/reports/ReportsPage.jsx';
import AuditLogPage from '../features/audit/AuditLogPage.jsx';
import InventoryPage from '../features/inventory/InventoryPage.jsx';
import PurchaseOrderFormPage from '../features/purchasing/PurchaseOrderFormPage.jsx';
import GrnFormPage from '../features/purchasing/GrnFormPage.jsx';
import TransferFormPage from '../features/transfers/TransferFormPage.jsx';
import TransferDetailPage from '../features/transfers/TransferDetailPage.jsx';
import SalesOrderFormPage from '../features/sales/SalesOrderFormPage.jsx';
import SalesOrderDetailPage from '../features/sales/SalesOrderDetailPage.jsx';
import DispatchFormPage from '../features/sales/DispatchFormPage.jsx';
import DispatchDetailPage from '../features/sales/DispatchDetailPage.jsx';
import StockCountFormPage from '../features/inventory/StockCountFormPage.jsx';
import StockCountDetailPage from '../features/inventory/StockCountDetailPage.jsx';
import UsersPage from '../features/users/UsersPage.jsx';
import PurchaseOrderDetailPage from '../features/purchasing/PurchaseOrderDetailPage.jsx';
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
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">
        Loading…
      </div>
    );
  }

  if (status !== 'authenticated') return <Navigate to="/login" replace />;

  // A temporary password must be replaced before anything else is reachable.
  if (session?.mustChangePassword) return <Navigate to="/change-password" replace />;

  if (permission && !permissions.includes(permission)) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-ink-soft">
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
      <p className="text-sm text-ink-soft">You do not have permission to view this page.</p>
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
        {/* Declared before the generated list routes so it is not shadowed. */}
        <Route
          path="/serials/:id"
          element={
            <RequirePermission permission="VIEW_SERIAL">
              <SerialDetailPage />
            </RequirePermission>
          }
        />
        {/* Also declared before the generated routes: "/service-requests/new"
            must not be read as a ticket id. */}
        <Route
          path="/service-requests/new"
          element={
            <RequirePermission permission="CREATE_SERVICE_REQUEST">
              <NewServiceRequestPage />
            </RequirePermission>
          }
        />
        <Route
          path="/service-requests/:id"
          element={
            <RequirePermission permission="VIEW_SERVICE_REQUEST">
              <ServiceRequestDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/customer-returns/:id"
          element={
            <RequirePermission permission="VIEW_RETURN">
              <CustomerReturnDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/reports"
          element={
            <RequirePermission permission="VIEW_REPORTS">
              <ReportsPage />
            </RequirePermission>
          }
        />
        {/* Declared before the generated list routes, like /serials/:id: a
            "new" path must not be read as a record id, and /inventory has a
            screen of its own because stock can be adjusted from it. */}
        <Route
          path="/purchase-orders/new"
          element={
            <RequirePermission permission="CREATE_PURCHASE_ORDER">
              <PurchaseOrderFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="/purchase-orders/:id"
          element={
            <RequirePermission permission="VIEW_PURCHASE_ORDER">
              <PurchaseOrderDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/grn/new"
          element={
            <RequirePermission permission="CREATE_GRN">
              <GrnFormPage />
            </RequirePermission>
          }
        />
        {/* Every "/new" is declared before its "/:id" sibling, or the router
            reads the word "new" as a record id. */}
        <Route path="/users" element={<RequirePermission permission="VIEW_USER"><UsersPage /></RequirePermission>} />
        <Route path="/transfers/new" element={<RequirePermission permission="CREATE_TRANSFER"><TransferFormPage /></RequirePermission>} />
        <Route path="/transfers/:id" element={<RequirePermission permission="VIEW_TRANSFER"><TransferDetailPage /></RequirePermission>} />
        <Route path="/sales-orders/new" element={<RequirePermission permission="CREATE_SALES_ORDER"><SalesOrderFormPage /></RequirePermission>} />
        <Route path="/sales-orders/:id" element={<RequirePermission permission="VIEW_SALES_ORDER"><SalesOrderDetailPage /></RequirePermission>} />
        <Route path="/dispatch-notes/new" element={<RequirePermission permission="CREATE_DISPATCH"><DispatchFormPage /></RequirePermission>} />
        <Route path="/dispatch-notes/:id" element={<RequirePermission permission="VIEW_DISPATCH_NOTE"><DispatchDetailPage /></RequirePermission>} />
        <Route path="/stock-counts/new" element={<RequirePermission permission="ADJUST_INVENTORY"><StockCountFormPage /></RequirePermission>} />
        <Route path="/stock-counts/:id" element={<RequirePermission permission="VIEW_INVENTORY"><StockCountDetailPage /></RequirePermission>} />
        <Route
          path="/inventory"
          element={
            <RequirePermission permission="VIEW_INVENTORY">
              <InventoryPage />
            </RequirePermission>
          }
        />
        <Route
          path="/audit-logs"
          element={
            <RequirePermission permission="VIEW_AUDIT_LOGS">
              <AuditLogPage />
            </RequirePermission>
          }
        />
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

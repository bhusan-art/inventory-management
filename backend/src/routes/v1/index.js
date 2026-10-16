import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import roleRoutes from './role.routes.js';
import permissionRoutes from './permission.routes.js';
import {
  categoryRouter, subcategoryRouter, brandRouter, manufacturerRouter,
  warehouseRouter, vendorRouter, customerRouter, productRouter,
} from './masterData.js';
import {
  purchaseOrderRouter, grnRouter, inventoryRouter, stockCountRouter, notificationRouter,
} from './purchase.routes.js';
import { transferRouter } from './transfer.routes.js';
import { serialRouter } from './serial.routes.js';
import { salesOrderRouter, dispatchRouter } from './sales.routes.js';
import { warrantyRouter, serviceRouter } from './warranty.routes.js';
import { customerReturnRouter, vendorReturnRouter } from './returns.routes.js';
import { documentRouter } from './documents.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { reportRouter } from './reports.routes.js';
import { auditRouter } from './audit.routes.js';
import { docsRouter } from './docs.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/permissions', permissionRoutes);

// Master data (Phase 2)
router.use('/categories', categoryRouter);
router.use('/subcategories', subcategoryRouter);
router.use('/brands', brandRouter);
router.use('/manufacturers', manufacturerRouter);
router.use('/warehouses', warehouseRouter);
router.use('/vendors', vendorRouter);
router.use('/customers', customerRouter);
router.use('/products', productRouter);

// Purchasing and inventory (Phase 3)
router.use('/purchase-orders', purchaseOrderRouter);
router.use('/grn', grnRouter);
router.use('/inventory', inventoryRouter);
router.use('/stock-counts', stockCountRouter);
router.use('/notifications', notificationRouter);

router.use('/transfers', transferRouter);
router.use('/serials', serialRouter);
router.use('/sales-orders', salesOrderRouter);
router.use('/dispatch-notes', dispatchRouter);
router.use('/warranties', warrantyRouter);
router.use('/service-requests', serviceRouter);
router.use('/customer-returns', customerReturnRouter);
router.use('/vendor-returns', vendorReturnRouter);
router.use('/documents', documentRouter);
router.use('/dashboard', dashboardRouter);
router.use('/reports', reportRouter);
router.use('/audit-logs', auditRouter);
router.use('/docs', docsRouter);

// Phase 7 mounts /sales-orders and /dispatch-notes here.

export default router;

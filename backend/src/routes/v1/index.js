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

// Phase 5 mounts /transfers here.

export default router;

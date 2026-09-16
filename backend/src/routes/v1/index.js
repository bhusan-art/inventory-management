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

// Phase 3 mounts /purchase-orders and /grn here.

export default router;

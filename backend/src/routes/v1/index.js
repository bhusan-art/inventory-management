import { Router } from 'express';
import healthRoutes from './health.routes.js';

const router = Router();

router.use('/health', healthRoutes);

// Phase 1 mounts /auth, /users, /roles here.
// Phase 2 mounts the master-data routers, and so on. Each router is
// responsible for declaring its own permission requirements at mount time.

export default router;

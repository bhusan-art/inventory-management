import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/reports.controller.js';
import { REPORT_KEYS } from '../../services/reports/reportService.js';

/**
 * Exports are rate limited separately.
 *
 * A report export is the largest single read the system allows — up to 50,000
 * rows with joins. Under the generic API budget one client could run dozens a
 * minute and flatten the database for everyone else.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'EXPORT_RATE_LIMITED',
    message: 'Too many exports. Try again shortly.',
  },
});

const keyParam = { params: z.object({ key: z.enum(REPORT_KEYS) }) };

const filters = z.object({
  warehouse: z.string().trim().optional(),
  product: z.string().trim().optional(),
  customer: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  transactionType: z.string().trim().max(40).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  state: z.string().trim().max(30).optional(),
  withinDays: z.coerce.number().int().min(1).max(3650).optional(),
  openOnly: z.coerce.boolean().optional(),
  belowReorderOnly: z.coerce.boolean().optional(),
  format: z.enum(['csv', 'xlsx']).optional(),
});

export const reportRouter = Router();
reportRouter.use(authenticate);

// VIEW_REPORTS opens the menu; each report then checks its own permission, so
// holding this alone reveals nothing.
reportRouter.get('/', requirePermission('VIEW_REPORTS'), controller.listReports);

reportRouter.get('/:key', requirePermission('VIEW_REPORTS'),
  validate({ ...keyParam, query: filters }), controller.runReport);

// Downloading data is a separate decision from reading it on screen.
reportRouter.get('/:key/export', exportLimiter, requirePermission('EXPORT_DATA'),
  validate({ ...keyParam, query: filters }), controller.exportReport);

export default reportRouter;

import { Router } from 'express';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import * as controller from '../../controllers/audit.controller.js';
import { objectIdSchema } from '../../validators/common.schema.js';

/**
 * Reading the audit trail.
 *
 * Every route needs VIEW_AUDIT_LOGS and there is no write route anywhere: the
 * model refuses updates and deletes at the ODM level, so the API has nothing
 * to expose even if someone added a handler.
 */
export const auditRouter = Router();
auditRouter.use(authenticate);
auditRouter.use(requirePermission('VIEW_AUDIT_LOGS'));

auditRouter.get('/', validate({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    action: z.string().trim().max(60).optional(),
    module: z.string().trim().max(60).optional(),
    severity: z.enum(['INFO', 'NOTICE', 'WARNING', 'CRITICAL']).optional(),
    actor: objectIdSchema.optional(),
    recordId: objectIdSchema.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    search: z.string().trim().max(80).optional(),
  }),
}), controller.listAuditLogs);

auditRouter.get('/vocabulary', controller.auditVocabulary);

auditRouter.get('/summary', validate({
  query: z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }),
}), controller.auditSummary);

auditRouter.get('/:module/:recordId', validate({
  params: z.object({
    module: z.string().trim().max(60),
    recordId: objectIdSchema,
  }),
}), controller.recordHistory);

export default auditRouter;

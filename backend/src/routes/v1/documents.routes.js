import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import authenticate from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/authorize.js';
import validate from '../../middleware/validate.js';
import { singleFile } from '../../middleware/upload.js';
import * as controller from '../../controllers/documents.controller.js';
import { idParamSchema, objectIdSchema } from '../../validators/common.schema.js';
import { DOCUMENT_ENTITIES, DOCUMENT_CATEGORIES } from '../../constants/documents.js';

/**
 * Uploads get their own rate limit.
 *
 * Every other endpoint costs a query. This one costs 15MB of memory and a disk
 * write, so the generic API limit is the wrong shape: a single client could
 * fill the disk inside the normal request budget.
 */
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'UPLOAD_RATE_LIMITED', message: 'Too many uploads. Try again shortly.' },
});

export const documentRouter = Router();
documentRouter.use(authenticate);

documentRouter.get('/', requirePermission('VIEW_DOCUMENT'),
  validate({
    query: z.object({
      entityType: z.enum(DOCUMENT_ENTITIES),
      entityId: objectIdSchema,
    }),
  }),
  controller.listDocuments);

documentRouter.get('/storage-summary', requirePermission('VIEW_DOCUMENT'),
  controller.storageSummary);

documentRouter.get('/:id/download', requirePermission('VIEW_DOCUMENT'),
  validate({ params: idParamSchema }), controller.downloadDocument);

/**
 * The upload order matters: authenticate, then authorize, then multer.
 *
 * Parsing the body before checking the permission would mean an unauthorised
 * caller could still make us buffer 15MB — authorization that costs as much as
 * the work it refuses is not much of a defence.
 *
 * Validation runs AFTER multer because the fields live in a multipart body that
 * does not exist until multer has parsed it.
 */
documentRouter.post('/',
  uploadLimiter,
  requirePermission('CREATE_DOCUMENT'),
  singleFile('file'),
  validate({
    body: z.object({
      entityType: z.enum(DOCUMENT_ENTITIES),
      entityId: objectIdSchema,
      category: z.enum(DOCUMENT_CATEGORIES).optional(),
      title: z.string().trim().max(200).optional(),
      description: z.string().trim().max(1000).optional(),
      // Multipart sends everything as a string.
      isRestricted: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
    }),
  }),
  controller.uploadDocument);

documentRouter.delete('/:id', requirePermission('DELETE_DOCUMENT'),
  validate({
    params: idParamSchema,
    body: z.object({ reason: z.string().trim().max(500).optional() }).default({}),
  }),
  controller.deleteDocument);

export default documentRouter;

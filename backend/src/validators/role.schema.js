import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';
import { ALL_PERMISSION_CODES } from '../constants/permissions.js';

const permissionCode = z.enum(ALL_PERMISSION_CODES);

export const createRoleSchema = {
  body: z.object({
    name: z.string().trim().min(2).max(60),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, 'Use A-Z, 0-9 and underscores'),
    description: z.string().trim().max(400).optional(),
    rank: z.coerce.number().int().min(0).max(99),
    permissions: z.array(permissionCode).max(500).default([]),
  }),
};

export const updateRoleSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    name: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().max(400).nullable().optional(),
    rank: z.coerce.number().int().min(0).max(99).optional(),
    permissions: z.array(permissionCode).max(500).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  }).refine((v) => Object.keys(v).length > 0, 'No changes supplied'),
};

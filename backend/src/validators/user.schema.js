import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';
import { passwordSchema } from './auth.schema.js';
import { ALL_PERMISSION_CODES } from '../constants/permissions.js';

const permissionCode = z.enum(ALL_PERMISSION_CODES);

export const createUserSchema = {
  body: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().max(20).optional(),
    password: passwordSchema.optional(),
    role: objectIdSchema,
    department: z.string().trim().max(80).optional(),
    sessionProfile: z.enum(['STANDARD', 'KIOSK']).default('STANDARD'),
    permissionGrants: z.array(permissionCode).max(200).default([]),
    permissionDenies: z.array(permissionCode).max(200).default([]),
    scope: z.object({ warehouseIds: z.array(objectIdSchema).default([]) }).default({ warehouseIds: [] }),
  }),
};

export const updateUserSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    role: objectIdSchema.optional(),
    department: z.string().trim().max(80).nullable().optional(),
    sessionProfile: z.enum(['STANDARD', 'KIOSK']).optional(),
  }).refine((v) => Object.keys(v).length > 0, 'No changes supplied'),
};

export const updateStatusSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED']) }),
};

export const updatePermissionsSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({
    permissionGrants: z.array(permissionCode).max(200).default([]),
    permissionDenies: z.array(permissionCode).max(200).default([]),
  }),
};

export const updateScopeSchema = {
  params: z.object({ id: objectIdSchema }),
  body: z.object({ warehouseIds: z.array(objectIdSchema).max(100).default([]) }),
};

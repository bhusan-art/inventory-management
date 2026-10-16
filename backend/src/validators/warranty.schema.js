import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';

export const warrantySchemas = {
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED']).optional(),
    state: z.enum(['ACTIVE', 'VOID', 'CLAIMED_REPLACED', 'TRANSFERRED']).optional(),
    customer: objectIdSchema.optional(),
    product: objectIdSchema.optional(),
    days: z.coerce.number().int().min(1).max(365).optional(),
    search: z.string().trim().max(60).optional(),
  }),

  void: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(5).max(300) }),
  },

  extend: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      additionalMonths: z.coerce.number().int().min(1).max(120),
      reason: z.string().trim().min(5).max(300),
    }),
  },
};

export const serviceSchemas = {
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.string().trim().max(30).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    customer: objectIdSchema.optional(),
    assignedTo: objectIdSchema.optional(),
    openOnly: z.coerce.boolean().optional(),
    search: z.string().trim().max(60).optional(),
  }),

  create: {
    body: z.object({
      serialNumber: z.string().trim().toUpperCase().max(80).optional(),
      customer: objectIdSchema.optional(),
      product: objectIdSchema.optional(),
      issueDescription: z.string().trim().min(10).max(2000),
      reportedDate: z.coerce.date().optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    }).refine((v) => v.serialNumber || (v.customer && v.product), {
      message: 'Provide a serial number, or both a customer and a product',
      path: ['serialNumber'],
    }),
  },

  assign: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      assignedTo: objectIdSchema.optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    }).refine((v) => v.assignedTo || v.priority, 'Nothing to change'),
  },

  receive: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      warehouse: objectIdSchema,
      note: z.string().trim().max(500).optional(),
    }),
  },

  status: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      status: z.enum(['UNDER_INSPECTION', 'SENT_TO_VENDOR', 'UNDER_REPAIR', 'REPAIRED', 'REJECTED']),
      note: z.string().trim().max(1000).optional(),
      vendor: objectIdSchema.optional(),
      vendorRmaNumber: z.string().trim().max(60).optional(),
      rootCause: z.string().trim().max(1000).optional(),
    }),
  },

  returnUnit: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ resolution: z.string().trim().min(5).max(2000) }),
  },

  replace: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      replacementSerialNumber: z.string().trim().toUpperCase().min(1).max(80),
      warehouse: objectIdSchema.optional(),
      resolution: z.string().trim().min(5).max(2000),
    }),
  },

  close: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ resolution: z.string().trim().max(2000).optional() }).default({}),
  },
};

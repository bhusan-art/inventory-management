import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';

const serial = z.string().trim().toUpperCase().min(1).max(80);

export const transferSchemas = {
  create: {
    body: z.object({
      sourceWarehouse: objectIdSchema,
      destinationWarehouse: objectIdSchema,
      vehicleNumber: z.string().trim().toUpperCase().max(20).nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        requestedQuantity: z.coerce.number().int().min(1).max(1_000_000),
        serialNumbers: z.array(serial).max(1000).default([]),
        remarks: z.string().trim().max(300).optional(),
      })).min(1).max(200),
    }).refine((v) => v.sourceWarehouse !== v.destinationWarehouse, {
      message: 'The source and destination must be different warehouses',
      path: ['destinationWarehouse'],
    }),
  },
  dispatch: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      vehicleNumber: z.string().trim().toUpperCase().max(20).optional(),
    }).default({}),
  },
  receive: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      remarks: z.string().trim().max(500).optional(),
      lines: z.array(z.object({
        lineId: objectIdSchema,
        receivedQuantity: z.coerce.number().int().min(0).max(1_000_000).optional(),
        damagedQuantity: z.coerce.number().int().min(0).max(1_000_000).optional(),
        receivedSerials: z.array(serial).max(1000).optional(),
        damagedSerials: z.array(serial).max(1000).optional(),
      })).min(1).max(200),
    }),
  },
  cancel: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  },
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.string().max(40).optional(),
    search: z.string().trim().max(60).optional(),
  }),
};

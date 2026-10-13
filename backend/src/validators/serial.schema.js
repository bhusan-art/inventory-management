import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';
import { SERIAL_STATUSES, ADJUSTMENT_REASONS } from '../constants/inventory.js';

const identifier = (max) => z.string().trim().toUpperCase().max(max).nullable().optional();

export const serialSchemas = {
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum(SERIAL_STATUSES).optional(),
    product: objectIdSchema.optional(),
    warehouse: objectIdSchema.optional(),
    customer: objectIdSchema.optional(),
    search: z.string().trim().max(80).optional(),
  }),

  scan: {
    params: z.object({
      // Permissive on length and characters: it is whatever the manufacturer
      // printed, and rejecting a real serial because of a slash or a space
      // makes the scanner useless at exactly the wrong moment.
      serialNumber: z.string().trim().min(1).max(80),
    }),
  },

  override: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      toStatus: z.enum(SERIAL_STATUSES),
      reasonCode: z.enum(ADJUSTMENT_REASONS),
      remarks: z.string().trim().min(10).max(500),
      warehouse: objectIdSchema.optional(),
    }),
  },

  attributes: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      assetTag: identifier(40),
      macAddress: z.string().trim().toUpperCase()
        .regex(/^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/, 'Not a valid MAC address')
        .nullable().optional(),
      imei: z.string().trim().regex(/^[0-9]{15}$/, 'An IMEI is 15 digits').nullable().optional(),
      installationLocation: z.string().trim().max(200).nullable().optional(),
      rackLocation: identifier(40),
      remarks: z.string().trim().max(500).nullable().optional(),
    }).refine((v) => Object.keys(v).length > 0, 'No changes supplied'),
  },

  labels: z.object({
    ids: z.string().optional(),
    copies: z.coerce.number().int().min(1).max(10).default(1),
  }),

  import: {
    body: z.object({
      csv: z.string().min(1).max(2_000_000),
      warehouse: objectIdSchema,
      dryRun: z.boolean().default(true),
    }),
  },
};

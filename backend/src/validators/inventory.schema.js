import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';
import { ADJUSTMENT_REASONS, BUCKET_NAMES } from '../constants/inventory.js';

const reasonCode = z.enum(ADJUSTMENT_REASONS);
const bucket = z.enum(BUCKET_NAMES);

export const adjustSchema = {
  body: z.object({
    product: objectIdSchema,
    warehouse: objectIdSchema,
    bucket: bucket.default('AVAILABLE'),
    newQuantity: z.coerce.number().int().min(0).max(10_000_000),
    reasonCode,
    remarks: z.string().trim().max(500).optional(),
  }),
};

export const reclassifySchema = {
  body: z.object({
    product: objectIdSchema,
    warehouse: objectIdSchema,
    fromBucket: bucket,
    toBucket: bucket,
    quantity: z.coerce.number().int().min(1).max(10_000_000),
    reasonCode,
    remarks: z.string().trim().max(500).optional(),
  }).refine((v) => v.fromBucket !== v.toBucket, {
    message: 'Source and destination buckets must differ',
    path: ['toBucket'],
  }),
};

export const countSchemas = {
  create: {
    body: z.object({
      warehouse: objectIdSchema,
      scope: z.enum(['FULL', 'CATEGORY', 'PRODUCT_LIST']).default('FULL'),
      category: objectIdSchema.nullable().optional(),
      products: z.array(objectIdSchema).max(2000).optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
    }).refine((v) => v.scope !== 'CATEGORY' || Boolean(v.category), {
      message: 'A category is required for a category-scoped count',
      path: ['category'],
    }).refine((v) => v.scope !== 'PRODUCT_LIST' || (v.products?.length ?? 0) > 0, {
      message: 'At least one product is required for a product-list count',
      path: ['products'],
    }),
  },
  record: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      entries: z.array(z.object({
        lineId: objectIdSchema,
        countedQuantity: z.coerce.number().int().min(0).max(10_000_000),
        remarks: z.string().trim().max(300).optional(),
      })).min(1).max(1000),
    }),
  },
  complete: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ remarks: z.string().trim().max(500).optional() }).default({}),
  },
  cancel: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  },
};

export const lowStockQuery = z.object({
  warehouse: objectIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

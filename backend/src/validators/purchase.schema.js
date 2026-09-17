import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';

const qty = (min = 0) => z.coerce.number().int().min(min).max(1_000_000);
const serial = z.string().trim().toUpperCase().min(1).max(80);

export const poSchemas = {
  create: {
    body: z.object({
      vendor: objectIdSchema,
      warehouse: objectIdSchema,
      orderDate: z.coerce.date().optional(),
      expectedDeliveryDate: z.coerce.date().nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        orderedQuantity: qty(1),
        expectedDeliveryDate: z.coerce.date().nullable().optional(),
        remarks: z.string().trim().max(300).nullable().optional(),
      })).min(1).max(200),
    }),
  },
  update: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      expectedDeliveryDate: z.coerce.date().nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        orderedQuantity: qty(1),
        remarks: z.string().trim().max(300).nullable().optional(),
      })).min(1).max(200).optional(),
    }),
  },
  close: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      // A mandatory reason is the point of the endpoint: an order closed short
      // with no explanation is indistinguishable from one lost track of.
      reason: z.string().trim().min(3).max(300),
    }),
  },
};

const grnLine = z.object({
  product: objectIdSchema,
  receivedQuantity: qty(0),
  acceptedQuantity: qty(0),
  damagedQuantity: qty(0).default(0),
  rejectedQuantity: qty(0).default(0),
  shortQuantity: qty(0).default(0),
  rackLocation: z.string().trim().toUpperCase().max(40).nullable().optional(),
  batchNumber: z.string().trim().max(60).nullable().optional(),
  manufacturingDate: z.coerce.date().nullable().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
  serialNumbers: z.array(serial).max(1000).default([]),
  remarks: z.string().trim().max(300).nullable().optional(),
}).refine(
  (l) => l.acceptedQuantity + l.damagedQuantity + l.rejectedQuantity === l.receivedQuantity,
  { message: 'Accepted + damaged + rejected must equal the quantity received', path: ['receivedQuantity'] },
).refine(
  (l) => l.receivedQuantity > 0 || l.shortQuantity > 0,
  { message: 'A line must record either a receipt or a shortage', path: ['receivedQuantity'] },
);

export const grnSchemas = {
  create: {
    body: z.object({
      vendor: objectIdSchema,
      purchaseOrder: objectIdSchema.nullable().optional(),
      warehouse: objectIdSchema,
      vendorInvoiceNumber: z.string().trim().max(60).nullable().optional(),
      vendorInvoiceDate: z.coerce.date().nullable().optional(),
      vendorChallanNumber: z.string().trim().max(60).nullable().optional(),
      receivedDate: z.coerce.date().optional(),
      vehicleNumber: z.string().trim().toUpperCase().max(20).nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(grnLine).min(1).max(200),
    }),
  },
  cancel: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  },
};

export const listPurchaseQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(200).optional(),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  vendor: objectIdSchema.optional(),
  pendingReceipt: z.coerce.boolean().optional(),
});

import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';

const serial = z.string().trim().toUpperCase().min(1).max(80);
const qty = z.coerce.number().int().min(1).max(1_000_000);

const addressSchema = z.object({
  label: z.string().trim().max(60).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, 'Postal code must be 6 digits').optional(),
  country: z.string().trim().max(80).optional(),
}).partial();

export const salesOrderSchemas = {
  create: {
    body: z.object({
      customer: objectIdSchema,
      warehouse: objectIdSchema,
      customerPoReference: z.string().trim().max(60).nullable().optional(),
      orderDate: z.coerce.date().optional(),
      requiredByDate: z.coerce.date().nullable().optional(),
      projectReference: z.string().trim().max(120).nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        orderedQuantity: qty,
        remarks: z.string().trim().max(300).nullable().optional(),
      })).min(1).max(200),
    }),
  },

  confirm: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      // Optional: naming serials picks exact units, omitting them lets the
      // system choose oldest-first.
      serialSelections: z.array(z.object({
        lineId: objectIdSchema,
        serialNumbers: z.array(serial).max(1000),
      })).max(200).default([]),
    }).default({}),
  },

  cancel: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  },

  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    sort: z.string().max(200).optional(),
    status: z.string().trim().max(40).optional(),
    customer: objectIdSchema.optional(),
    search: z.string().trim().max(60).optional(),
  }),
};

export const dispatchSchemas = {
  create: {
    body: z.object({
      customer: objectIdSchema,
      warehouse: objectIdSchema,
      salesOrder: objectIdSchema.nullable().optional(),
      dispatchDate: z.coerce.date().optional(),
      shippingAddress: addressSchema.optional(),
      vehicleNumber: z.string().trim().toUpperCase().max(20).nullable().optional(),
      transporter: z.string().trim().max(120).nullable().optional(),
      lrNumber: z.string().trim().max(60).nullable().optional(),
      remarks: z.string().trim().max(500).nullable().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        salesOrderLineId: objectIdSchema.nullable().optional(),
        quantity: qty,
        serialNumbers: z.array(serial).max(1000).default([]),
        remarks: z.string().trim().max(300).nullable().optional(),
      })).min(1).max(200),
    }),
  },

  deliver: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      deliveredDate: z.coerce.date().optional(),
      receivedByName: z.string().trim().max(120).optional(),
    }).default({}),
  },

  cancel: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  },

  list: salesOrderSchemas.list,
};

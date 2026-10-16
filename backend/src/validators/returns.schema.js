import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';
import {
  CUSTOMER_RETURN_REASONS, VENDOR_RETURN_REASONS, DISPOSITIONS,
  VENDOR_RETURN_SOURCE_BUCKETS,
} from '../constants/returns.js';

const serialList = z.array(z.string().trim().toUpperCase().min(1).max(80)).max(500);

export const customerReturnSchemas = {
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum([
      'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'RECEIVED', 'CLOSED',
    ]).optional(),
    customer: objectIdSchema.optional(),
    warehouse: objectIdSchema.optional(),
    reason: z.enum(CUSTOMER_RETURN_REASONS).optional(),
    pendingDisposition: z.coerce.boolean().optional(),
    search: z.string().trim().max(60).optional(),
  }),

  create: {
    body: z.object({
      customer: objectIdSchema,
      warehouse: objectIdSchema,
      dispatchNote: objectIdSchema.optional(),
      reason: z.enum(CUSTOMER_RETURN_REASONS),
      reasonDetail: z.string().trim().max(1000).optional(),
      requestedDate: z.coerce.date().optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        requestedQuantity: z.coerce.number().int().min(1).max(100_000),
        reportedCondition: z.string().trim().max(500).optional(),
        remarks: z.string().trim().max(500).optional(),
      })).min(1).max(200),
    }),
  },

  status: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED']),
      reason: z.string().trim().min(3).max(500).optional(),
    }),
  },

  receive: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      lines: z.array(z.object({
        lineId: objectIdSchema,
        receivedQuantity: z.coerce.number().int().min(0).max(100_000),
        serialNumbers: serialList.optional(),
        condition: z.string().trim().max(500).optional(),
      })).min(1),
    }),
  },

  disposition: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      lineId: objectIdSchema,
      disposition: z.enum(DISPOSITIONS),
      quantity: z.coerce.number().int().min(1).max(100_000),
      serialNumbers: serialList.optional(),
      inspectionNotes: z.string().trim().max(1000).optional(),
    }),
  },
};

export const vendorReturnSchemas = {
  list: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum([
      'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'SENT', 'CLOSED',
    ]).optional(),
    vendor: objectIdSchema.optional(),
    warehouse: objectIdSchema.optional(),
    reason: z.enum(VENDOR_RETURN_REASONS).optional(),
    awaitingReplacement: z.coerce.boolean().optional(),
    search: z.string().trim().max(60).optional(),
  }),

  create: {
    body: z.object({
      vendor: objectIdSchema,
      warehouse: objectIdSchema,
      grn: objectIdSchema.optional(),
      reason: z.enum(VENDOR_RETURN_REASONS),
      reasonDetail: z.string().trim().max(1000).optional(),
      expectReplacement: z.boolean().optional(),
      vendorRmaNumber: z.string().trim().max(60).optional(),
      lines: z.array(z.object({
        product: objectIdSchema,
        quantity: z.coerce.number().int().min(1).max(100_000),
        sourceBucket: z.enum(VENDOR_RETURN_SOURCE_BUCKETS).default('DAMAGED'),
        customerReturn: objectIdSchema.optional(),
        remarks: z.string().trim().max(500).optional(),
      })).min(1).max(200),
    }),
  },

  status: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED']),
      reason: z.string().trim().min(3).max(500).optional(),
    }),
  },

  send: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      courier: z.string().trim().max(100).optional(),
      trackingNumber: z.string().trim().max(100).optional(),
      vendorRmaNumber: z.string().trim().max(60).optional(),
    }).default({}),
  },

  fromCustomerReturn: {
    params: z.object({ id: objectIdSchema }),
    body: z.object({
      vendor: objectIdSchema,
      reason: z.enum(VENDOR_RETURN_REASONS),
      reasonDetail: z.string().trim().max(1000).optional(),
      expectReplacement: z.boolean().optional(),
      vendorRmaNumber: z.string().trim().max(60).optional(),
    }),
  },
};

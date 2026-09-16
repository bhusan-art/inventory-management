import { z } from 'zod';
import { objectIdSchema } from './common.schema.js';

const code = (max = 30) =>
  z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, hyphen or underscore').max(max);

const name = (max = 120) => z.string().trim().min(2).max(max);
const optionalText = (max) => z.string().trim().max(max).nullable().optional();

/**
 * GSTIN: 2-digit state code, 10-character PAN, entity number, 'Z', checksum.
 * Validated structurally rather than as a loose 15-character string, because a
 * malformed GSTIN is only discovered when a statutory document is rejected.
 */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Not a valid GSTIN')
  .nullable()
  .optional();

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Not a valid PAN')
  .nullable()
  .optional();

const addressSchema = z.object({
  label: optionalText(60),
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, 'Postal code must be 6 digits').nullable().optional(),
  country: optionalText(80),
}).partial();

const statusEnum = (...values) => z.enum(values).optional();

// ---------------------------------------------------------------- classification

const classificationBody = z.object({
  name: name(),
  code: code(),
  description: optionalText(500),
  status: statusEnum('ACTIVE', 'INACTIVE'),
});

export const categorySchemas = {
  create: { body: classificationBody },
  update: { params: z.object({ id: objectIdSchema }), body: classificationBody.partial() },
};

export const brandSchemas = categorySchemas;

export const manufacturerSchemas = {
  create: {
    body: classificationBody.extend({
      website: optionalText(200),
      supportEmail: z.string().trim().toLowerCase().email().nullable().optional(),
    }),
  },
  update: {
    params: z.object({ id: objectIdSchema }),
    body: classificationBody.extend({
      website: optionalText(200),
      supportEmail: z.string().trim().toLowerCase().email().nullable().optional(),
    }).partial(),
  },
};

export const subcategorySchemas = {
  create: { body: classificationBody.extend({ category: objectIdSchema }) },
  update: {
    params: z.object({ id: objectIdSchema }),
    body: classificationBody.extend({ category: objectIdSchema }).partial(),
  },
};

// ---------------------------------------------------------------- warehouse

const warehouseBody = z.object({
  name: name(),
  code: code(20),
  type: z.enum(['MAIN', 'BRANCH', 'SERVICE_CENTER']).default('MAIN'),
  address: addressSchema.optional(),
  contactNumber: optionalText(20),
  manager: objectIdSchema.nullable().optional(),
  racks: z.array(z.object({
    code: code(20),
    description: optionalText(120),
    shelves: z.array(z.string().trim().max(20)).max(200).default([]),
  })).max(500).default([]),
  status: statusEnum('ACTIVE', 'INACTIVE'),
});

export const warehouseSchemas = {
  // TRANSIT and SCRAP are absent from the input enum on purpose: they are
  // created by the seed and must stay unique, so the API cannot mint more.
  create: { body: warehouseBody },
  update: { params: z.object({ id: objectIdSchema }), body: warehouseBody.partial() },
};

// ---------------------------------------------------------------- vendor & customer

const vendorBody = z.object({
  vendorName: name(200),
  vendorCode: code(),
  contactPerson: optionalText(120),
  phone: optionalText(20),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  address: addressSchema.optional(),
  gstin,
  pan,
  bankDetails: z.object({
    accountName: optionalText(120),
    accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, 'Account number must be 6-20 digits').nullable().optional(),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Not a valid IFSC').nullable().optional(),
    bankName: optionalText(120),
    branch: optionalText(120),
  }).partial().nullable().optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  remarks: optionalText(500),
  status: statusEnum('ACTIVE', 'INACTIVE', 'BLACKLISTED'),
});

export const vendorSchemas = {
  create: { body: vendorBody },
  update: { params: z.object({ id: objectIdSchema }), body: vendorBody.partial() },
};

const customerBody = z.object({
  customerName: name(200),
  customerCode: code(),
  companyName: optionalText(200),
  contactPerson: optionalText(120),
  phone: optionalText(20),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  billingAddress: addressSchema.optional(),
  shippingAddresses: z.array(addressSchema).max(20).default([]),
  gstin,
  pan,
  customerType: z.enum(['EXTERNAL', 'INTERNAL_DEPARTMENT', 'PROJECT_SITE']).default('EXTERNAL'),
  remarks: optionalText(500),
  status: statusEnum('ACTIVE', 'INACTIVE', 'ON_HOLD'),
});

export const customerSchemas = {
  create: { body: customerBody },
  update: { params: z.object({ id: objectIdSchema }), body: customerBody.partial() },
};

// ---------------------------------------------------------------- product

const productBody = z.object({
  name: name(200),
  productCode: code(40),
  sku: code(40),
  category: objectIdSchema,
  subcategory: objectIdSchema.nullable().optional(),
  brand: objectIdSchema.nullable().optional(),
  manufacturer: objectIdSchema.nullable().optional(),
  modelNumber: optionalText(80),
  description: optionalText(2000),
  specifications: z.array(z.object({
    key: z.string().trim().max(60),
    value: z.string().trim().max(200),
  })).max(100).default([]),
  unitOfMeasure: z.enum(['PCS', 'BOX', 'MTR', 'KG', 'SET', 'LTR', 'ROLL']).default('PCS'),
  productType: z.enum(['SERIALIZED', 'NON_SERIALIZED']),
  trackingAttributes: z.object({
    requiresImei: z.boolean().default(false),
    requiresMac: z.boolean().default(false),
    requiresAssetTag: z.boolean().default(false),
  }).partial().default({}),
  serialFormatPattern: optionalText(200),
  minStockLevel: z.coerce.number().int().min(0).default(0),
  reorderLevel: z.coerce.number().int().min(0).default(0),
  reorderQuantity: z.coerce.number().int().min(0).default(0),
  maxStockLevel: z.coerce.number().int().min(0).default(0),
  warrantyMonths: z.coerce.number().int().min(0).max(600).default(0),
  shelfLifeDays: z.coerce.number().int().min(0).nullable().optional(),
  hsnCode: z.string().trim().regex(/^[0-9]{4,8}$/, 'HSN must be 4-8 digits').nullable().optional(),
  status: statusEnum('ACTIVE', 'DISCONTINUED', 'INACTIVE'),
}).refine(
  // Serial-format and IMEI/MAC/asset-tag rules only mean something for units
  // that are individually tracked.
  (v) => v.productType === 'SERIALIZED' || !v.serialFormatPattern,
  { message: 'A serial number format only applies to serialized products', path: ['serialFormatPattern'] },
);

export const productSchemas = {
  create: { body: productBody },
  update: {
    params: z.object({ id: objectIdSchema }),
    body: productBody.innerType().partial(),
  },
};

export const importSchema = {
  body: z.object({
    csv: z.string().min(1).max(2_000_000),
    dryRun: z.boolean().default(true),
  }),
};

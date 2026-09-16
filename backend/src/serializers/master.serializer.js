import { serialize, serializeMany } from './serialize.js';

const ref = (v) => (v && typeof v === 'object' && v._id
  ? { id: String(v._id), name: v.name ?? null, code: v.code ?? null }
  : v ? String(v) : null);

const base = (d) => ({
  id: String(d._id),
  status: d.status,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

const classification = (d) => ({
  ...base(d),
  name: d.name,
  code: d.code,
  description: d.description ?? null,
});

const mappers = {
  Category: classification,
  Brand: classification,

  Manufacturer: (d) => ({
    ...classification(d),
    website: d.website ?? null,
    supportEmail: d.supportEmail ?? null,
  }),

  Subcategory: (d) => ({ ...classification(d), category: ref(d.category) }),

  Warehouse: (d) => ({
    ...base(d),
    name: d.name,
    code: d.code,
    type: d.type,
    address: d.address ?? null,
    contactNumber: d.contactNumber ?? null,
    manager: d.manager && typeof d.manager === 'object'
      ? { id: String(d.manager._id), fullName: d.manager.fullName }
      : d.manager ? String(d.manager) : null,
    racks: d.racks ?? [],
    rackCount: (d.racks ?? []).length,
    isSystem: Boolean(d.isSystem),
  }),

  Vendor: (d) => {
    const dto = {
      ...base(d),
      vendorName: d.vendorName,
      vendorCode: d.vendorCode,
      contactPerson: d.contactPerson ?? null,
      address: d.address ?? null,
      gstin: d.gstin ?? null,
      pan: d.pan ?? null,
      leadTimeDays: d.leadTimeDays ?? null,
      remarks: d.remarks ?? null,
    };
    // Present only when the actor holds the permission — stripRestricted has
    // already removed them otherwise.
    if ('phone' in d) dto.phone = d.phone ?? null;
    if ('email' in d) dto.email = d.email ?? null;
    if ('bankDetails' in d) dto.bankDetails = maskBankDetails(d.bankDetails);
    return dto;
  },

  Customer: (d) => {
    const dto = {
      ...base(d),
      customerName: d.customerName,
      customerCode: d.customerCode,
      companyName: d.companyName ?? null,
      contactPerson: d.contactPerson ?? null,
      customerType: d.customerType,
      billingAddress: d.billingAddress ?? null,
      shippingAddresses: d.shippingAddresses ?? [],
      gstin: d.gstin ?? null,
      pan: d.pan ?? null,
      remarks: d.remarks ?? null,
    };
    if ('phone' in d) dto.phone = d.phone ?? null;
    if ('email' in d) dto.email = d.email ?? null;
    return dto;
  },

  Product: (d) => ({
    ...base(d),
    name: d.name,
    sku: d.sku,
    productCode: d.productCode,
    category: ref(d.category),
    subcategory: ref(d.subcategory),
    brand: ref(d.brand),
    manufacturer: ref(d.manufacturer),
    modelNumber: d.modelNumber ?? null,
    description: d.description ?? null,
    specifications: d.specifications ?? [],
    unitOfMeasure: d.unitOfMeasure,
    productType: d.productType,
    trackingAttributes: d.trackingAttributes ?? {},
    serialFormatPattern: d.serialFormatPattern ?? null,
    stockLevels: {
      min: d.minStockLevel ?? 0,
      reorder: d.reorderLevel ?? 0,
      reorderQuantity: d.reorderQuantity ?? 0,
      max: d.maxStockLevel ?? 0,
    },
    warrantyMonths: d.warrantyMonths ?? 0,
    shelfLifeDays: d.shelfLifeDays ?? null,
    hsnCode: d.hsnCode ?? null,
  }),
};

/**
 * Bank account numbers are shown as the last four digits even to holders of
 * VIEW_VENDOR_BANK_DETAILS.
 *
 * The permission answers "may this person confirm which account we pay" — the
 * last four digits do that. Rendering the full number on a list screen puts it
 * in browser history, screenshots and shoulder-view for no additional benefit.
 * The unmasked value is available on the dedicated endpoint, which audits each
 * read.
 */
export function maskBankDetails(bank) {
  if (!bank) return null;
  const account = String(bank.accountNumber ?? '');
  return {
    accountName: bank.accountName ?? null,
    bankName: bank.bankName ?? null,
    branch: bank.branch ?? null,
    ifsc: bank.ifsc ?? null,
    accountNumberMasked: account ? `••••${account.slice(-4)}` : null,
  };
}

export function serializeMaster(modelName, doc, permissions) {
  return serialize(doc, { modelName, mapper: mappers[modelName], permissions });
}

export function serializeMasterMany(modelName, docs, permissions) {
  return serializeMany(docs, { modelName, mapper: mappers[modelName], permissions });
}

export { mappers };

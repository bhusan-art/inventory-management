/**
 * Document upload — mostly a list of things we refuse.
 *
 * File upload is the single richest vulnerability surface in a web
 * application, so every decision here is made in the restrictive direction.
 */

/**
 * What a document is attached to.
 *
 * A fixed list, not an arbitrary string. The download route resolves the parent
 * to check the actor may see it, and that check is only possible against
 * models we know about.
 */
export const DOCUMENT_ENTITIES = Object.freeze([
  'PURCHASE_ORDER', 'GRN', 'DISPATCH_NOTE', 'SALES_ORDER',
  'SERIAL', 'WARRANTY', 'SERVICE_REQUEST',
  'CUSTOMER_RETURN', 'VENDOR_RETURN',
  'PRODUCT', 'VENDOR', 'CUSTOMER', 'TRANSFER',
]);

/** Maps each entity to the Mongoose model holding it. */
export const ENTITY_MODEL = Object.freeze({
  PURCHASE_ORDER: 'PurchaseOrder',
  GRN: 'GRN',
  DISPATCH_NOTE: 'DispatchNote',
  SALES_ORDER: 'SalesOrder',
  SERIAL: 'SerialNumber',
  WARRANTY: 'Warranty',
  SERVICE_REQUEST: 'ServiceRequest',
  CUSTOMER_RETURN: 'CustomerReturn',
  VENDOR_RETURN: 'VendorReturn',
  PRODUCT: 'Product',
  VENDOR: 'Vendor',
  CUSTOMER: 'Customer',
  TRANSFER: 'WarehouseTransfer',
});

/**
 * The permission needed to see the parent record.
 *
 * Without this, attaching a document to a record would be a way to read data
 * the actor is not entitled to: a vendor's bank details photographed and
 * attached to a product would be readable by anyone who can view products.
 */
export const ENTITY_VIEW_PERMISSION = Object.freeze({
  PURCHASE_ORDER: 'VIEW_PURCHASE_ORDER',
  GRN: 'VIEW_GRN',
  DISPATCH_NOTE: 'VIEW_DISPATCH_NOTE',
  SALES_ORDER: 'VIEW_SALES_ORDER',
  SERIAL: 'VIEW_SERIAL',
  WARRANTY: 'VIEW_WARRANTY',
  SERVICE_REQUEST: 'VIEW_SERVICE_REQUEST',
  CUSTOMER_RETURN: 'VIEW_RETURN',
  VENDOR_RETURN: 'VIEW_RETURN',
  PRODUCT: 'VIEW_PRODUCT',
  VENDOR: 'VIEW_VENDOR',
  CUSTOMER: 'VIEW_CUSTOMER',
  TRANSFER: 'VIEW_TRANSFER',
});

export const DOCUMENT_CATEGORIES = Object.freeze([
  'INVOICE', 'DELIVERY_CHALLAN', 'PACKING_LIST', 'WARRANTY_CERTIFICATE',
  'INSPECTION_REPORT', 'SERVICE_REPORT', 'PHOTO', 'SIGNED_ACKNOWLEDGEMENT',
  'RMA_AUTHORISATION', 'DATASHEET', 'OTHER',
]);

/**
 * An ALLOWLIST of accepted types, keyed by MIME, each with its one canonical
 * extension and magic bytes.
 *
 * Allowlist, not blocklist: a blocklist is a bet that you thought of every
 * dangerous type, and that bet loses the first time a browser learns to
 * execute something new.
 *
 * Note what is absent and why:
 *
 *   SVG   is XML, it can carry <script>, and browsers execute it when the file
 *         is rendered inline. An image format that runs code is not an image.
 *   HTML  same reasoning, less disguise.
 *   ZIP   cannot be inspected without unpacking it, and unpacking untrusted
 *         archives is its own vulnerability class (zip bombs, path traversal
 *         through crafted entry names).
 *
 * `magic` is the file's leading bytes. The browser's Content-Type header is
 * supplied by whoever is uploading and is therefore worth nothing on its own;
 * the bytes are checked against it in documentService.
 */
export const ALLOWED_TYPES = Object.freeze({
  'application/pdf': { ext: '.pdf', magic: ['25504446'] },                 // %PDF
  'image/jpeg': { ext: '.jpg', magic: ['ffd8ff'] },
  'image/png': { ext: '.png', magic: ['89504e470d0a1a0a'] },
  'image/webp': { ext: '.webp', magic: ['52494646'] },                     // RIFF
  'text/csv': { ext: '.csv', magic: null },                                // no signature
  'text/plain': { ext: '.txt', magic: null },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    ext: '.xlsx', magic: ['504b0304'],                                     // PK..
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: '.docx', magic: ['504b0304'],
  },
});

export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(ALLOWED_TYPES));

/** 15 MB. Large enough for a scanned multi-page challan, small enough to bound disk use. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** How many files one request may carry. */
export const MAX_FILES_PER_REQUEST = 10;

/**
 * Types served inline to the browser. Everything else downloads.
 *
 * A PDF viewer runs in a sandboxed context; an image renders as pixels. Those
 * are safe to display. Anything not on this list gets
 * `Content-Disposition: attachment`, which stops the browser treating our
 * domain as the origin of content somebody else supplied.
 */
export const INLINE_SAFE_TYPES = Object.freeze([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

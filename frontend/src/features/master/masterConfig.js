/**
 * Master-data screens are the same screen with different columns, so they are
 * described as data rather than written seven times.
 *
 * `permission` on a column hides it for actors who lack it. That is a courtesy,
 * not a control — the API already omits the field, so the cell would be empty
 * anyway. Hiding the column stops the table looking broken.
 */
export const MASTER_CONFIGS = {
  products: {
    title: 'Products',
    endpoint: 'products',
    permissions: { view: 'VIEW_PRODUCT', create: 'CREATE_PRODUCT' },
    searchPlaceholder: 'Search by name, SKU or model…',
    columns: [
      { key: 'sku', label: 'SKU', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'category', label: 'Category', render: (r) => r.category?.name ?? '—' },
      { key: 'brand', label: 'Brand', render: (r) => r.brand?.name ?? '—' },
      { key: 'productType', label: 'Type', render: (r) => (r.productType ? (r.productType === 'SERIALIZED' ? 'Serialized' : 'Bulk') : '—') },
      { key: 'unitOfMeasure', label: 'UoM' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  categories: {
    title: 'Categories',
    endpoint: 'categories',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  brands: {
    title: 'Brands',
    endpoint: 'brands',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  manufacturers: {
    title: 'Manufacturers',
    endpoint: 'manufacturers',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'website', label: 'Website' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  warehouses: {
    title: 'Warehouses',
    endpoint: 'warehouses',
    permissions: { view: 'VIEW_WAREHOUSE', create: 'CREATE_WAREHOUSE' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'city', label: 'City', render: (r) => r.address?.city ?? '—' },
      { key: 'rackCount', label: 'Racks' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  vendors: {
    title: 'Vendors',
    endpoint: 'vendors',
    permissions: { view: 'VIEW_VENDOR', create: 'CREATE_VENDOR' },
    searchPlaceholder: 'Search by name, code or GSTIN…',
    columns: [
      { key: 'vendorCode', label: 'Code', mono: true },
      { key: 'vendorName', label: 'Name' },
      { key: 'contactPerson', label: 'Contact' },
      // Absent from the API response without the permission, so the column
      // would render a row of dashes. Hide it instead.
      { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
      { key: 'leadTimeDays', label: 'Lead time', render: (r) => (r.leadTimeDays ? `${r.leadTimeDays} d` : '—') },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  customers: {
    title: 'Customers',
    endpoint: 'customers',
    permissions: { view: 'VIEW_CUSTOMER', create: 'CREATE_CUSTOMER' },
    columns: [
      { key: 'customerCode', label: 'Code', mono: true },
      { key: 'customerName', label: 'Name' },
      { key: 'companyName', label: 'Company' },
      { key: 'customerType', label: 'Type', render: (r) => humanize(r.customerType) },
      { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  // ---- Phase 3: purchasing and inventory ----
  // Not master data, but the same list shape: server-side search, pagination
  // and permission-filtered columns. Reusing the component rather than writing
  // three near-identical pages.
  'purchase-orders': {
    title: 'Purchase Orders',
    endpoint: 'purchase-orders',
    permissions: { view: 'VIEW_PURCHASE_ORDER', create: 'CREATE_PURCHASE_ORDER' },
    searchPlaceholder: 'Search by PO number…',
    columns: [
      { key: 'poNumber', label: 'PO number', mono: true },
      { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name ?? '—' },
      { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
      { key: 'orderDate', label: 'Ordered', render: (r) => formatDate(r.orderDate) },
      { key: 'ordered', label: 'Qty', render: (r) => r.totals?.ordered ?? 0 },
      // The number an operator actually asks for: what is still to come.
      { key: 'outstanding', label: 'Outstanding', render: (r) => r.totals?.outstanding ?? 0 },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  grn: {
    title: 'Goods Received',
    endpoint: 'grn',
    permissions: { view: 'VIEW_GRN', create: 'CREATE_GRN' },
    searchPlaceholder: 'Search by GRN number…',
    columns: [
      { key: 'grnNumber', label: 'GRN number', mono: true },
      { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name ?? '—' },
      { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
      { key: 'receivedDate', label: 'Received', render: (r) => formatDate(r.receivedDate) },
      { key: 'accepted', label: 'Accepted', render: (r) => r.totals?.accepted ?? 0 },
      { key: 'damaged', label: 'Damaged', render: (r) => r.totals?.damaged ?? 0 },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  inventory: {
    title: 'Inventory',
    endpoint: 'inventory',
    permissions: { view: 'VIEW_INVENTORY' },
    searchable: false,
    columns: [
      { key: 'sku', label: 'SKU', mono: true, render: (r) => r.product?.code ?? '—' },
      { key: 'product', label: 'Product', render: (r) => r.product?.name ?? '—' },
      { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
      { key: 'available', label: 'Available' },
      { key: 'reserved', label: 'Reserved' },
      { key: 'damaged', label: 'Damaged' },
      { key: 'total', label: 'Total' },
    ],
  },

  transfers: {
    title: 'Warehouse Transfers',
    endpoint: 'transfers',
    permissions: { view: 'VIEW_TRANSFER', create: 'CREATE_TRANSFER' },
    searchPlaceholder: 'Search by transfer number…',
    columns: [
      { key: 'transferNumber', label: 'Transfer', mono: true },
      { key: 'from', label: 'From', render: (r) => r.sourceWarehouse?.name ?? '—' },
      { key: 'to', label: 'To', render: (r) => r.destinationWarehouse?.name ?? '—' },
      { key: 'requested', label: 'Qty', render: (r) => r.totals?.requested ?? 0 },
      // The column that matters mid-journey: what is on the road right now.
      { key: 'inTransit', label: 'In transit', render: (r) => r.totals?.inTransit ?? 0 },
      { key: 'received', label: 'Received', render: (r) => r.totals?.received ?? 0 },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  serials: {
    title: 'Serial Numbers',
    endpoint: 'serials',
    permissions: { view: 'VIEW_SERIAL', create: 'CREATE_SERIAL' },
    searchPlaceholder: 'Serial, asset tag, MAC or IMEI…',
    rowLink: (r) => `/serials/${r.id}`,
    columns: [
      { key: 'serialNumber', label: 'Serial', mono: true },
      { key: 'product', label: 'Product', render: (r) => r.product?.name ?? '—' },
      { key: 'warehouse', label: 'Location', render: (r) => r.warehouse?.name ?? '—' },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'assetTag', label: 'Asset tag', mono: true },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  users: {
    title: 'Users',
    endpoint: 'users',
    permissions: { view: 'VIEW_USER', create: 'CREATE_USER' },
    searchPlaceholder: 'Search by name or email…',
    columns: [
      { key: 'fullName', label: 'Name' },
      { key: 'email', label: 'Email', mono: true },
      { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
      { key: 'role', label: 'Role', render: (r) => r.role?.name ?? '—' },
      { key: 'department', label: 'Department' },
      { key: 'lastLoginAt', label: 'Last sign-in', render: (r) => formatDate(r.lastLoginAt) },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  'stock-counts': {
    title: 'Stock Counts',
    endpoint: 'stock-counts',
    permissions: { view: 'VIEW_INVENTORY', create: 'ADJUST_INVENTORY' },
    searchable: false,
    columns: [
      { key: 'countNumber', label: 'Count', mono: true },
      { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
      { key: 'scope', label: 'Scope', render: (r) => humanize(r.scope) },
      { key: 'progress', label: 'Counted', render: (r) => `${r.progress?.counted ?? 0} / ${r.progress?.total ?? 0}` },
      { key: 'variances', label: 'Variances', render: (r) => r.progress?.variances ?? 0 },
      { key: 'snapshotAt', label: 'Started', render: (r) => formatDate(r.snapshotAt) },
      { key: 'status', label: 'Status', status: true },
    ],
  },
};

/**
 * Renderers must survive a row that does not have their field.
 *
 * `r.customerType.replace(...)` crashed the whole page the first time a stale
 * product row was rendered against the customer columns — and because a render
 * crash unmounts the tree before effects run, the fetch that would have
 * replaced those rows never fired. The route key above fixes the cause; these
 * guards mean a single unexpected row shape degrades one cell instead of
 * taking down the screen.
 */
function humanize(value) {
  if (!value) return '—';
  return String(value).replace(/_/g, ' ').toLowerCase();
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default MASTER_CONFIGS;

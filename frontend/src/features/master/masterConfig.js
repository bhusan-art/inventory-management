/**
 * Master-data screens are the same screen with different columns, so they are
 * described as data rather than written seven times.
 *
 * `permission` on a column hides it for actors who lack it. That is a courtesy,
 * not a control — the API already omits the field, so the cell would be empty
 * anyway. Hiding the column stops the table looking broken.
 */

/**
 * Shared because three entities use exactly these two and a fourth uses them
 * plus one more. Written out per entity, they drift.
 */
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];

export const MASTER_CONFIGS = {
  products: {
    title: 'Products',
    endpoint: 'products',
    permissions: { view: 'VIEW_PRODUCT', create: 'CREATE_PRODUCT', update: 'UPDATE_PRODUCT', remove: 'DELETE_PRODUCT' },
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
    fields: [
      { name: 'name', label: 'Product name', type: 'text', required: true, max: 200 },
      { name: 'sku', label: 'SKU', type: 'text', required: true, max: 40, uppercase: true, mono: true,
        help: 'Letters, digits, hyphen or underscore.' },
      { name: 'productCode', label: 'Product code', type: 'text', required: true, max: 40, uppercase: true, mono: true },
      { name: 'category', label: 'Category', type: 'reference', endpoint: 'categories', required: true },
      { name: 'subcategory', label: 'Subcategory', type: 'reference', endpoint: 'subcategories' },
      { name: 'brand', label: 'Brand', type: 'reference', endpoint: 'brands' },
      { name: 'manufacturer', label: 'Manufacturer', type: 'reference', endpoint: 'manufacturers' },
      // The decision that cannot be undone casually: it determines whether
      // every unit needs its own serial number for the rest of its life.
      { name: 'productType', label: 'Tracking', type: 'select', required: true, default: 'NON_SERIALIZED',
        options: [
          { value: 'NON_SERIALIZED', label: 'Bulk quantity' },
          { value: 'SERIALIZED', label: 'Serialized — each unit tracked individually' },
        ],
        help: 'Serialized units are received one serial at a time and can be traced to a customer.' },
      { name: 'unitOfMeasure', label: 'Unit of measure', type: 'select', required: true, default: 'PCS',
        options: ['PCS', 'BOX', 'MTR', 'KG', 'SET', 'LTR', 'ROLL'].map((v) => ({ value: v, label: v })) },
      { name: 'modelNumber', label: 'Model number', type: 'text', max: 80 },
      { name: 'hsnCode', label: 'HSN code', type: 'text', max: 8, help: '4 to 8 digits.' },
      { name: 'warrantyMonths', label: 'Warranty (months)', type: 'number', min: 0, max: 600, default: 0 },
      { name: 'shelfLifeDays', label: 'Shelf life (days)', type: 'number', min: 0 },
      { name: 'minStockLevel', label: 'Minimum stock', type: 'number', min: 0, default: 0 },
      { name: 'reorderLevel', label: 'Reorder at', type: 'number', min: 0, default: 0,
        help: 'Drives the low-stock report.' },
      { name: 'reorderQuantity', label: 'Reorder quantity', type: 'number', min: 0, default: 0 },
      { name: 'maxStockLevel', label: 'Maximum stock', type: 'number', min: 0, default: 0 },
      // Only meaningful for individually tracked units, and the server refuses
      // the combination outright — so the field disappears rather than being
      // accepted and then rejected.
      { name: 'serialFormatPattern', label: 'Serial number format', type: 'text', max: 200,
        when: (v) => v.productType === 'SERIALIZED' },
      { name: 'description', label: 'Description', type: 'textarea', max: 2000 },
      { name: 'specifications', label: 'Specifications', type: 'keyvalue' },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE',
        options: [
          { value: 'ACTIVE', label: 'Active' },
          { value: 'DISCONTINUED', label: 'Discontinued' },
          { value: 'INACTIVE', label: 'Inactive' },
        ] },
    ],
  },

  categories: {
    title: 'Categories',
    endpoint: 'categories',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY', update: 'UPDATE_CATEGORY', remove: 'DELETE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'code', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE', options: STATUS_OPTIONS },
    ],
  },

  subcategories: {
    title: 'Subcategories',
    endpoint: 'subcategories',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY', update: 'UPDATE_CATEGORY', remove: 'DELETE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'category', label: 'Category', render: (r) => r.category?.name ?? '—' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'code', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      // Required by the schema. Without a screen here the product form offered
      // a Subcategory dropdown that could only ever say "none exist yet", with
      // nowhere to go and create one.
      { name: 'category', label: 'Parent category', type: 'reference', endpoint: 'categories', required: true },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE', options: STATUS_OPTIONS },
    ],
  },

  brands: {
    title: 'Brands',
    endpoint: 'brands',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY', update: 'UPDATE_CATEGORY', remove: 'DELETE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'code', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE', options: STATUS_OPTIONS },
    ],
  },

  manufacturers: {
    title: 'Manufacturers',
    endpoint: 'manufacturers',
    permissions: { view: 'VIEW_CATEGORY', create: 'CREATE_CATEGORY', update: 'UPDATE_CATEGORY', remove: 'DELETE_CATEGORY' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'website', label: 'Website' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'code', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      { name: 'website', label: 'Website', type: 'text', max: 200 },
      { name: 'supportEmail', label: 'Support email', type: 'text', inputType: 'email', max: 200 },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE', options: STATUS_OPTIONS },
    ],
  },

  warehouses: {
    title: 'Warehouses',
    endpoint: 'warehouses',
    permissions: { view: 'VIEW_WAREHOUSE', create: 'CREATE_WAREHOUSE', update: 'UPDATE_WAREHOUSE', remove: 'DELETE_WAREHOUSE' },
    columns: [
      { key: 'code', label: 'Code', mono: true },
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'city', label: 'City', render: (r) => r.address?.city ?? '—' },
      { key: 'rackCount', label: 'Racks' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'name', label: 'Warehouse name', type: 'text', required: true, max: 120 },
      { name: 'code', label: 'Code', type: 'text', required: true, max: 20, uppercase: true, mono: true },
      // TRANSIT and SCRAP are absent deliberately: the seed creates exactly one
      // of each and they must stay unique, so the API will not mint more.
      { name: 'type', label: 'Type', type: 'select', required: true, default: 'MAIN',
        options: [
          { value: 'MAIN', label: 'Main' },
          { value: 'BRANCH', label: 'Branch' },
          { value: 'SERVICE_CENTER', label: 'Service centre' },
        ] },
      { name: 'contactNumber', label: 'Contact number', type: 'text', max: 20 },
      { name: 'address', label: 'Address', type: 'address' },
      { name: 'racks', label: 'Racks', type: 'racks' },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE', options: STATUS_OPTIONS },
    ],
  },

  vendors: {
    title: 'Vendors',
    endpoint: 'vendors',
    permissions: { view: 'VIEW_VENDOR', create: 'CREATE_VENDOR', update: 'UPDATE_VENDOR', remove: 'DELETE_VENDOR' },
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
    fields: [
      { name: 'vendorName', label: 'Vendor name', type: 'text', required: true, max: 200 },
      { name: 'vendorCode', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      { name: 'contactPerson', label: 'Contact person', type: 'text', max: 120 },
      { name: 'phone', label: 'Phone', type: 'text', max: 20 },
      { name: 'email', label: 'Email', type: 'text', inputType: 'email', max: 200 },
      { name: 'gstin', label: 'GSTIN', type: 'text', max: 15, uppercase: true, mono: true,
        help: 'Checked structurally — a malformed GSTIN is only found when a statutory document is rejected.' },
      { name: 'pan', label: 'PAN', type: 'text', max: 10, uppercase: true, mono: true },
      { name: 'leadTimeDays', label: 'Lead time (days)', type: 'number', min: 0, max: 365 },
      { name: 'address', label: 'Address', type: 'address' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE',
        options: [
          { value: 'ACTIVE', label: 'Active' },
          { value: 'INACTIVE', label: 'Inactive' },
          { value: 'BLACKLISTED', label: 'Blacklisted' },
        ] },
    ],
  },

  customers: {
    title: 'Customers',
    endpoint: 'customers',
    permissions: { view: 'VIEW_CUSTOMER', create: 'CREATE_CUSTOMER', update: 'UPDATE_CUSTOMER', remove: 'DELETE_CUSTOMER' },
    columns: [
      { key: 'customerCode', label: 'Code', mono: true },
      { key: 'customerName', label: 'Name' },
      { key: 'companyName', label: 'Company' },
      { key: 'customerType', label: 'Type', render: (r) => humanize(r.customerType) },
      { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
      { key: 'status', label: 'Status', status: true },
    ],
    fields: [
      { name: 'customerName', label: 'Customer name', type: 'text', required: true, max: 200 },
      { name: 'customerCode', label: 'Code', type: 'text', required: true, max: 30, uppercase: true, mono: true },
      { name: 'customerType', label: 'Type', type: 'select', required: true, default: 'EXTERNAL',
        options: [
          { value: 'EXTERNAL', label: 'External' },
          { value: 'INTERNAL_DEPARTMENT', label: 'Internal department' },
          { value: 'PROJECT_SITE', label: 'Project site' },
        ] },
      { name: 'companyName', label: 'Company', type: 'text', max: 200 },
      { name: 'contactPerson', label: 'Contact person', type: 'text', max: 120 },
      { name: 'phone', label: 'Phone', type: 'text', max: 20 },
      { name: 'email', label: 'Email', type: 'text', inputType: 'email', max: 200 },
      { name: 'gstin', label: 'GSTIN', type: 'text', max: 15, uppercase: true, mono: true },
      { name: 'pan', label: 'PAN', type: 'text', max: 10, uppercase: true, mono: true },
      { name: 'billingAddress', label: 'Billing address', type: 'address' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', max: 500 },
      { name: 'status', label: 'Status', type: 'select', default: 'ACTIVE',
        options: [
          { value: 'ACTIVE', label: 'Active' },
          { value: 'INACTIVE', label: 'Inactive' },
          { value: 'ON_HOLD', label: 'On hold' },
        ] },
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
    headerAction: { to: '/purchase-orders/new', label: 'New order', permission: 'CREATE_PURCHASE_ORDER' },
    rowLink: (r) => `/purchase-orders/${r.id}`,
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
    headerAction: { to: '/grn/new', label: 'Receive goods', permission: 'CREATE_GRN' },
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
    headerAction: { to: '/transfers/new', label: 'New transfer', permission: 'CREATE_TRANSFER' },
    rowLink: (r) => `/transfers/${r.id}`,
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

  'sales-orders': {
    title: 'Sales Orders',
    endpoint: 'sales-orders',
    permissions: { view: 'VIEW_SALES_ORDER', create: 'CREATE_SALES_ORDER' },
    headerAction: { to: '/sales-orders/new', label: 'New order', permission: 'CREATE_SALES_ORDER' },
    rowLink: (r) => `/sales-orders/${r.id}`,
    searchPlaceholder: 'Search by order number…',
    columns: [
      { key: 'salesOrderNumber', label: 'Order', mono: true },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'orderDate', label: 'Ordered', render: (r) => formatDate(r.orderDate) },
      { key: 'ordered', label: 'Qty', render: (r) => r.totals?.ordered ?? 0 },
      // What is claimed but not yet shipped — the number a salesperson asks for.
      { key: 'reserved', label: 'Reserved', render: (r) => r.totals?.reserved ?? 0 },
      { key: 'outstanding', label: 'Outstanding', render: (r) => r.totals?.outstanding ?? 0 },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  'dispatch-notes': {
    title: 'Dispatch Notes',
    endpoint: 'dispatch-notes',
    permissions: { view: 'VIEW_DISPATCH_NOTE', create: 'CREATE_DISPATCH' },
    headerAction: { to: '/dispatch-notes/new', label: 'New dispatch', permission: 'CREATE_DISPATCH' },
    rowLink: (r) => `/dispatch-notes/${r.id}`,
    searchPlaceholder: 'Search by dispatch number…',
    columns: [
      { key: 'dispatchNoteNumber', label: 'Dispatch', mono: true },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'dispatchDate', label: 'Dispatched', render: (r) => formatDate(r.dispatchDate) },
      { key: 'units', label: 'Units', render: (r) => r.totals?.units ?? 0 },
      { key: 'serials', label: 'Serials', render: (r) => r.totals?.serials ?? 0 },
      { key: 'vehicleNumber', label: 'Vehicle', mono: true },
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
    headerAction: { to: '/stock-counts/new', label: 'New count', permission: 'ADJUST_INVENTORY' },
    rowLink: (r) => `/stock-counts/${r.id}`,
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

  warranties: {
    title: 'Warranties',
    endpoint: 'warranties',
    permissions: { view: 'VIEW_WARRANTY' },
    searchPlaceholder: 'Search by warranty number…',
    // Cover belongs to a unit, so the row opens the unit's own page rather
    // than a warranty page that would repeat most of it.
    rowLink: (r) => (r.serialNumber?.id ? `/serials/${r.serialNumber.id}` : null),
    columns: [
      { key: 'warrantyNumber', label: 'Warranty', mono: true },
      { key: 'serialNumber', label: 'Serial', mono: true, render: (r) => r.serialNumber?.serialNumber ?? '—' },
      { key: 'product', label: 'Product', render: (r) => r.product?.name ?? '—' },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'endDate', label: 'Cover until', render: (r) => formatDate(r.endDate) },
      // The API computes this on every read; there is no stored status field to
      // fall out of date, which is why the column can be trusted.
      { key: 'daysRemaining', label: 'Days left', render: (r) => remaining(r.daysRemaining) },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  'customer-returns': {
    title: 'Customer Returns',
    endpoint: 'customer-returns',
    permissions: { view: 'VIEW_RETURN', create: 'CREATE_RETURN' },
    searchPlaceholder: 'Search by return number…',
    rowLink: (r) => `/customer-returns/${r.id}`,
    columns: [
      { key: 'returnNumber', label: 'Return', mono: true },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'reason', label: 'Reason', render: (r) => humanize(r.reason) },
      { key: 'requested', label: 'Claimed', render: (r) => r.totals?.requested ?? 0 },
      { key: 'received', label: 'Arrived', render: (r) => r.totals?.received ?? 0 },
      // The number that matters operationally: stock sitting in quarantine
      // that nobody has looked at yet.
      { key: 'pending', label: 'To inspect', render: (r) => r.totals?.pendingDisposition ?? 0 },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  'vendor-returns': {
    title: 'Vendor Returns',
    endpoint: 'vendor-returns',
    permissions: { view: 'VIEW_RETURN', create: 'CREATE_RETURN' },
    searchPlaceholder: 'Search by return number…',
    columns: [
      { key: 'returnNumber', label: 'Return', mono: true },
      { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name ?? '—' },
      { key: 'reason', label: 'Reason', render: (r) => humanize(r.reason) },
      { key: 'units', label: 'Units', render: (r) => r.totals?.units ?? 0 },
      {
        key: 'expectReplacement',
        label: 'Replacement',
        render: (r) => (r.expectReplacement ? 'expected' : '—'),
      },
      { key: 'trackingNumber', label: 'Tracking', mono: true },
      { key: 'status', label: 'Status', status: true },
    ],
  },

  'service-requests': {
    title: 'Service Requests',
    endpoint: 'service-requests',
    permissions: { view: 'VIEW_SERVICE_REQUEST', create: 'CREATE_SERVICE_REQUEST' },
    searchPlaceholder: 'Search by ticket number…',
    rowLink: (r) => `/service-requests/${r.id}`,
    headerAction: { to: '/service-requests/new', label: 'Raise a ticket', permission: 'CREATE_SERVICE_REQUEST' },
    columns: [
      { key: 'ticketNumber', label: 'Ticket', mono: true },
      { key: 'serialNumber', label: 'Serial', mono: true, render: (r) => r.serialNumber?.serialNumber ?? '—' },
      { key: 'customer', label: 'Customer', render: (r) => r.customer?.name ?? '—' },
      { key: 'priority', label: 'Priority', render: (r) => humanize(r.priority) },
      {
        key: 'warrantyApplicable',
        label: 'Cover',
        // Frozen when the ticket was raised, not recomputed now: the customer
        // reported the fault while covered, so a lapse since then is ours.
        render: (r) => (r.warrantyApplicable === true ? 'In warranty'
          : r.warrantyApplicable === false ? 'Chargeable' : '—'),
      },
      { key: 'slaDueDate', label: 'SLA due', render: (r) => sla(r) },
      { key: 'assignedTo', label: 'Engineer', render: (r) => r.assignedTo?.name ?? 'Unassigned' },
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

function remaining(days) {
  if (days === null || days === undefined) return '—';
  if (days < 0) return `${Math.abs(days)} overdue`;
  return String(days);
}

/**
 * An SLA is only interesting while the ticket is still ours to act on, so a
 * breach on a resolved ticket is shown as a plain date rather than an alarm.
 */
function sla(row) {
  if (!row.slaDueDate) return '—';
  const date = formatDate(row.slaDueDate);
  return row.slaBreached ? `${date} · breached` : date;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default MASTER_CONFIGS;

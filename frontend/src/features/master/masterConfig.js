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
      { key: 'productType', label: 'Type', render: (r) => (r.productType === 'SERIALIZED' ? 'Serialized' : 'Bulk') },
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
      { key: 'customerType', label: 'Type', render: (r) => r.customerType.replace(/_/g, ' ').toLowerCase() },
      { key: 'phone', label: 'Phone', permission: 'VIEW_CONTACT_DETAILS' },
      { key: 'status', label: 'Status', status: true },
    ],
  },
};

export default MASTER_CONFIGS;

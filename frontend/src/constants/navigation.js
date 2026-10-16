import {
  LayoutDashboard, Package, Tags, Building2, Users, Warehouse,
  Factory, BadgeCheck, Contact, ClipboardList, PackageCheck, Boxes, ClipboardCheck, Truck,
  ScanLine, ShoppingCart, Send, ShieldCheck, Wrench, Undo2, CornerUpLeft, BarChart3,
  ScrollText,
} from 'lucide-react';

/**
 * The sidebar is generated from this list, and every entry carries the
 * permission that gates it.
 *
 * One list rather than a hand-maintained menu plus separate route guards: the
 * two cannot drift apart into a sidebar offering a page the user is refused,
 * or hiding one they are entitled to.
 */
export const NAVIGATION = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },

  {
    section: 'Operations',
    items: [
      { label: 'Purchase Orders', to: '/purchase-orders', icon: ClipboardList, permission: 'VIEW_PURCHASE_ORDER' },
      { label: 'Goods Received', to: '/grn', icon: PackageCheck, permission: 'VIEW_GRN' },
      { label: 'Inventory', to: '/inventory', icon: Boxes, permission: 'VIEW_INVENTORY' },
      { label: 'Transfers', to: '/transfers', icon: Truck, permission: 'VIEW_TRANSFER' },
      { label: 'Serial Numbers', to: '/serials', icon: ScanLine, permission: 'VIEW_SERIAL' },
      { label: 'Sales Orders', to: '/sales-orders', icon: ShoppingCart, permission: 'VIEW_SALES_ORDER' },
      { label: 'Dispatch Notes', to: '/dispatch-notes', icon: Send, permission: 'VIEW_DISPATCH_NOTE' },
      { label: 'Stock Counts', to: '/stock-counts', icon: ClipboardCheck, permission: 'VIEW_INVENTORY' },
    ],
  },

  {
    section: 'Service',
    items: [
      { label: 'Warranties', to: '/warranties', icon: ShieldCheck, permission: 'VIEW_WARRANTY' },
      { label: 'Service Requests', to: '/service-requests', icon: Wrench, permission: 'VIEW_SERVICE_REQUEST' },
      { label: 'Customer Returns', to: '/customer-returns', icon: Undo2, permission: 'VIEW_RETURN' },
      { label: 'Vendor Returns', to: '/vendor-returns', icon: CornerUpLeft, permission: 'VIEW_RETURN' },
    ],
  },

  {
    section: 'Master data',
    items: [
      { label: 'Products', to: '/products', icon: Package, permission: 'VIEW_PRODUCT' },
      { label: 'Categories', to: '/categories', icon: Tags, permission: 'VIEW_CATEGORY' },
      { label: 'Subcategories', to: '/subcategories', icon: Tags, permission: 'VIEW_CATEGORY' },
      { label: 'Brands', to: '/brands', icon: BadgeCheck, permission: 'VIEW_CATEGORY' },
      { label: 'Manufacturers', to: '/manufacturers', icon: Factory, permission: 'VIEW_CATEGORY' },
      { label: 'Warehouses', to: '/warehouses', icon: Warehouse, permission: 'VIEW_WAREHOUSE' },
      { label: 'Vendors', to: '/vendors', icon: Building2, permission: 'VIEW_VENDOR' },
      { label: 'Customers', to: '/customers', icon: Contact, permission: 'VIEW_CUSTOMER' },
    ],
  },

  {
    section: 'Administration',
    items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, permission: 'VIEW_REPORTS' },
      { label: 'Users', to: '/users', icon: Users, permission: 'VIEW_USER' },
      { label: 'Audit Trail', to: '/audit-logs', icon: ScrollText, permission: 'VIEW_AUDIT_LOGS' },
    ],
  },
];

/** Drops entries the actor cannot reach, then drops sections left empty. */
export function visibleNavigation(permissions) {
  const allowed = (item) => !item.permission || permissions.has(item.permission);

  return NAVIGATION.reduce((acc, entry) => {
    if (!entry.section) {
      if (allowed(entry)) acc.push(entry);
      return acc;
    }
    const items = entry.items.filter(allowed);
    if (items.length > 0) acc.push({ ...entry, items });
    return acc;
  }, []);
}

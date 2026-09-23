import {
  LayoutDashboard, Package, Tags, Building2, Users, Warehouse,
  Factory, BadgeCheck, Contact, ClipboardList, PackageCheck, Boxes, ClipboardCheck,
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
      { label: 'Stock Counts', to: '/stock-counts', icon: ClipboardCheck, permission: 'VIEW_INVENTORY' },
    ],
  },

  {
    section: 'Master data',
    items: [
      { label: 'Products', to: '/products', icon: Package, permission: 'VIEW_PRODUCT' },
      { label: 'Categories', to: '/categories', icon: Tags, permission: 'VIEW_CATEGORY' },
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
      { label: 'Users', to: '/users', icon: Users, permission: 'VIEW_USER' },
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

/**
 * Seed script.
 *
 * Idempotent: safe to run repeatedly. Creates the tenant company, syncs the
 * permission catalogue, creates the seven system roles, and creates one user
 * per role.
 *
 * Passwords are generated at run time and printed once. They are never stored
 * in the repository, never the same twice, and every seeded account is flagged
 * `mustChangePassword`. A seed that ships a known password is a seed that ends
 * up in production with that password still working.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import env from '../config/env.js';
import logger from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Company } from '../models/Company.js';
import { Role } from '../models/Role.js';
import { Permission } from '../models/Permission.js';
import { User, hashPassword } from '../models/User.js';
import { Warehouse } from '../models/Warehouse.js';
import { Category, Subcategory, Brand, Manufacturer } from '../models/classification.js';
import { Vendor } from '../models/Vendor.js';
import { Customer } from '../models/Customer.js';
import { Product } from '../models/Product.js';
import { PERMISSION_DEFINITIONS } from '../constants/permissions.js';
import { SYSTEM_ROLE_LIST } from '../constants/roles.js';

const FORCE = process.argv.includes('--force');

function generatePassword() {
  // 18 URL-safe characters plus guaranteed letter and digit, satisfying the
  // policy without producing anything a human would choose.
  return `${crypto.randomBytes(13).toString('base64url')}7x`;
}

async function syncPermissionCatalogue() {
  const ops = PERMISSION_DEFINITIONS.map((p) => ({
    updateOne: {
      filter: { _id: p.code },
      update: { $set: { module: p.module, label: p.label, restricted: p.restricted } },
      upsert: true,
    },
  }));
  await Permission.bulkWrite(ops);

  // Remove entries that no longer exist in the constants, so the UI never
  // offers a permission nothing checks.
  const codes = PERMISSION_DEFINITIONS.map((p) => p.code);
  const { deletedCount } = await Permission.deleteMany({ _id: { $nin: codes } });

  logger.info({ synced: ops.length, removed: deletedCount }, 'Permission catalogue synced');
}

async function seedCompany() {
  const existing = await Company.findOne({ code: 'DEFAULT' });
  if (existing) return existing;

  const company = await Company.create({
    name: process.env.SEED_COMPANY_NAME ?? 'Scorigx Innovations Private Limited',
    code: 'DEFAULT',
    financialYearStartMonth: 4,
    status: 'ACTIVE',
  });
  logger.info({ id: String(company._id) }, 'Tenant company created');
  return company;
}

async function seedRoles(tenantId) {
  const roles = {};
  for (const definition of SYSTEM_ROLE_LIST) {
    const role = await Role.findOneAndUpdate(
      { tenantId, code: definition.code },
      {
        $set: {
          name: definition.name,
          description: definition.description,
          permissions: definition.permissions,
          rank: definition.rank,
          isSystem: true,
          status: 'ACTIVE',
          deletedAt: null,
        },
        $setOnInsert: { tenantId },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    roles[definition.code] = role;
  }
  logger.info({ count: Object.keys(roles).length }, 'System roles synced');
  return roles;
}

const SEED_USERS = [
  ['SUPER_ADMIN', 'Super Admin', 'superadmin@example.com', 'Management'],
  ['ADMIN', 'Admin User', 'admin@example.com', 'Management'],
  ['INVENTORY_MANAGER', 'Inventory Manager', 'inventory@example.com', 'Operations'],
  ['WAREHOUSE_OPERATOR', 'Warehouse Operator', 'warehouse@example.com', 'Warehouse'],
  ['SALES_DISPATCH', 'Sales & Dispatch', 'sales@example.com', 'Sales'],
  ['SERVICE_ENGINEER', 'Service Engineer', 'service@example.com', 'Service'],
  ['VIEWER', 'Viewer', 'viewer@example.com', 'Management'],
];

async function seedUsers(tenantId, roles) {
  const credentials = [];

  for (const [roleCode, fullName, email, department] of SEED_USERS) {
    const existing = await User.findOne({ tenantId, email });
    if (existing && !FORCE) {
      credentials.push({ email, password: '(unchanged — already exists)' });
      continue;
    }

    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    await User.findOneAndUpdate(
      { tenantId, email },
      {
        $set: {
          fullName,
          passwordHash,
          role: roles[roleCode]._id,
          department,
          status: 'ACTIVE',
          mustChangePassword: true,
          sessionProfile: roleCode === 'WAREHOUSE_OPERATOR' ? 'KIOSK' : 'STANDARD',
          deletedAt: null,
        },
        $setOnInsert: { tenantId, email },
        $inc: { tokenVersion: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    credentials.push({ email, password, role: roles[roleCode].name });
  }

  return credentials;
}

/**
 * TRANSIT and SCRAP are required by the transfer and write-off flows, which
 * assume exactly one of each exists. They are created here as `isSystem` so
 * the API cannot create more or delete these.
 */
async function seedSystemWarehouses(tenantId) {
  const system = [
    { code: 'TRANSIT', name: 'In Transit', type: 'TRANSIT' },
    { code: 'SCRAP', name: 'Scrap / Write-off', type: 'SCRAP' },
  ];

  for (const w of system) {
    await Warehouse.findOneAndUpdate(
      { tenantId, code: w.code },
      { $set: { ...w, isSystem: true, status: 'ACTIVE', deletedAt: null }, $setOnInsert: { tenantId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  logger.info({ count: system.length }, 'System warehouses ensured');
}

/**
 * Demo master data. Deliberately shaped like a fibre-optic and IT
 * infrastructure business: a mix of serialized capital equipment and
 * non-serialized consumables, which is what exercises the two inventory paths
 * differently in later phases.
 */
async function seedMasterData(tenantId) {
  if (process.env.SEED_DEMO_DATA === 'false') return;

  const upsert = async (Model, key, doc) => {
    const found = await Model.findOneAndUpdate(
      { tenantId, ...key },
      { $set: { ...doc, deletedAt: null }, $setOnInsert: { tenantId, ...key } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return found;
  };

  const categories = {};
  for (const [code, name] of [
    ['IT-HARDWARE', 'IT Hardware'],
    ['NETWORKING', 'Networking'],
    ['FIBRE', 'Fibre Optic'],
    ['CONSUMABLES', 'Consumables'],
    ['TOOLS', 'Tools & Test Equipment'],
  ]) {
    categories[code] = await upsert(Category, { code }, { name });
  }

  const subcategories = {};
  for (const [code, name, cat] of [
    ['SERVER', 'Servers', 'IT-HARDWARE'],
    ['SWITCH', 'Switches', 'NETWORKING'],
    ['ROUTER', 'Routers', 'NETWORKING'],
    ['OFC', 'Optical Fibre Cable', 'FIBRE'],
    ['SPLICE', 'Splicing & Closures', 'FIBRE'],
    ['PATCH', 'Patch Cords', 'CONSUMABLES'],
  ]) {
    subcategories[code] = await upsert(Subcategory, { code }, { name, category: categories[cat]._id });
  }

  const brands = {};
  for (const [code, name] of [
    ['DELL', 'Dell'], ['CISCO', 'Cisco'], ['HP', 'HP'],
    ['STERLITE', 'Sterlite'], ['FUJIKURA', 'Fujikura'], ['DLINK', 'D-Link'],
  ]) {
    brands[code] = await upsert(Brand, { code }, { name });
  }

  const manufacturers = {};
  for (const [code, name] of [
    ['DELL-TECH', 'Dell Technologies'],
    ['CISCO-SYS', 'Cisco Systems'],
    ['STL', 'Sterlite Technologies'],
  ]) {
    manufacturers[code] = await upsert(Manufacturer, { code }, { name });
  }

  for (const [code, name, type, city] of [
    ['WH-HYD', 'Hyderabad Main Warehouse', 'MAIN', 'Hyderabad'],
    ['WH-BLR', 'Bengaluru Branch', 'BRANCH', 'Bengaluru'],
    ['WH-SVC', 'Service Centre', 'SERVICE_CENTER', 'Hyderabad'],
  ]) {
    await upsert(Warehouse, { code }, {
      name, type,
      address: { city, state: city === 'Hyderabad' ? 'Telangana' : 'Karnataka', country: 'India' },
      racks: [
        { code: 'R1', description: 'Rack 1', shelves: ['S1', 'S2', 'S3'] },
        { code: 'R2', description: 'Rack 2', shelves: ['S1', 'S2'] },
      ],
    });
  }

  for (const [vendorCode, vendorName, leadTimeDays] of [
    ['V-DELL', 'Dell India Pvt Ltd', 21],
    ['V-STL', 'Sterlite Technologies Ltd', 14],
    ['V-LOCAL', 'Hyderabad Cable Supplies', 3],
  ]) {
    await upsert(Vendor, { vendorCode }, { vendorName, leadTimeDays, status: 'ACTIVE' });
  }

  for (const [customerCode, customerName, customerType] of [
    ['C-ACME', 'ACME Technologies Pvt Ltd', 'EXTERNAL'],
    ['C-BSNL', 'BSNL Circle Office', 'EXTERNAL'],
    ['C-SITE1', 'Project Site — Gachibowli', 'PROJECT_SITE'],
  ]) {
    await upsert(Customer, { customerCode }, { customerName, customerType, status: 'ACTIVE' });
  }

  const products = [
    ['PowerEdge R760 Rack Server', 'SRV-DELL-R760', 'PC-0001', 'IT-HARDWARE', 'SERVER', 'DELL', 'SERIALIZED', 'PCS', 36, 1, 2, 10],
    ['Catalyst 9300 48-Port Switch', 'SW-CISCO-9300', 'PC-0002', 'NETWORKING', 'SWITCH', 'CISCO', 'SERIALIZED', 'PCS', 60, 2, 4, 20],
    ['24F Single Mode OFC', 'OFC-SM-24F', 'PC-0003', 'FIBRE', 'OFC', 'STERLITE', 'NON_SERIALIZED', 'MTR', 0, 2000, 5000, 50000],
    ['Fusion Splicer 90S', 'TOOL-FUJI-90S', 'PC-0004', 'TOOLS', null, 'FUJIKURA', 'SERIALIZED', 'PCS', 24, 1, 1, 5],
    ['LC-LC Patch Cord 3m', 'PC-LCLC-3M', 'PC-0005', 'CONSUMABLES', 'PATCH', 'DLINK', 'NON_SERIALIZED', 'PCS', 0, 100, 250, 2000],
    ['Fibre Splice Closure 24F', 'SPL-CLOSURE-24', 'PC-0006', 'FIBRE', 'SPLICE', 'STERLITE', 'NON_SERIALIZED', 'PCS', 0, 50, 100, 500],
  ];

  for (const [name, sku, productCode, cat, sub, brand, productType, uom, warranty, min, reorder, max] of products) {
    await upsert(Product, { sku }, {
      name,
      productCode,
      category: categories[cat]._id,
      subcategory: sub ? subcategories[sub]._id : null,
      brand: brands[brand]._id,
      manufacturer: manufacturers[cat === 'FIBRE' ? 'STL' : cat === 'NETWORKING' ? 'CISCO-SYS' : 'DELL-TECH']?._id ?? null,
      productType,
      unitOfMeasure: uom,
      warrantyMonths: warranty,
      minStockLevel: min,
      reorderLevel: reorder,
      maxStockLevel: max,
      status: 'ACTIVE',
    });
  }

  logger.info({ products: products.length }, 'Demo master data seeded');
}

async function run() {
  if (env.isProduction && !FORCE) {
    logger.error('Refusing to seed in production. Re-run with --force if you are certain.');
    process.exit(1);
  }

  await connectDatabase();

  const company = await seedCompany();
  await syncPermissionCatalogue();
  const roles = await seedRoles(company._id);
  const credentials = await seedUsers(company._id, roles);
  await seedSystemWarehouses(company._id);
  await seedMasterData(company._id);

  /* eslint-disable no-console */
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(' SEEDED ACCOUNTS — shown once. Copy them now.');
  console.log(' Every account must change its password at first sign-in.');
  console.log('─────────────────────────────────────────────────────────────');
  for (const c of credentials) {
    console.log(` ${c.email.padEnd(30)} ${c.password}`);
  }
  console.log('─────────────────────────────────────────────────────────────\n');
  /* eslint-enable no-console */

  await disconnectDatabase();
  await mongoose.disconnect().catch(() => {});
}

run().catch((err) => {
  logger.fatal({ err }, 'Seed failed');
  process.exit(1);
});

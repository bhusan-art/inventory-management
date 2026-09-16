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

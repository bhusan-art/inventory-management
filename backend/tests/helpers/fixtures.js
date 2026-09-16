import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { Company } from '../../src/models/Company.js';
import { Role } from '../../src/models/Role.js';
import { User, hashPassword } from '../../src/models/User.js';
import { SYSTEM_ROLE_LIST } from '../../src/constants/roles.js';
import { clearAuthCache } from '../../src/middleware/authenticate.js';

export const TEST_PASSWORD = 'TestPassword123xyz';

export const app = createApp();

export async function resetDatabase() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  clearAuthCache();
}

/** Creates the tenant plus all seven system roles. */
export async function seedTenant() {
  const company = await Company.create({ name: 'Test Co', code: 'TEST' });

  const roles = {};
  for (const def of SYSTEM_ROLE_LIST) {
    roles[def.code] = await Role.create({
      tenantId: company._id,
      code: def.code,
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      rank: def.rank,
      isSystem: true,
    });
  }

  return { company, roles };
}

export async function createUser({ company, role, email, overrides = {} }) {
  return User.create({
    tenantId: company._id,
    fullName: `User ${email}`,
    email,
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: role._id,
    status: 'ACTIVE',
    ...overrides,
  });
}

/** Logs in and returns { accessToken, cookie, session } for use in requests. */
export async function signIn(email, password = TEST_PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    accessToken: res.body.data.accessToken,
    cookie: res.headers['set-cookie'],
    session: res.body.data.session,
  };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

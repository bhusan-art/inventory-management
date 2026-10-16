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

/**
 * Creates the tenant plus all seven system roles.
 *
 * Takes a name and code so a suite can seed a SECOND tenant: cross-tenant
 * isolation cannot be tested with one tenant, and every `tenantId` filter in
 * the system is untested until someone else's data exists to leak.
 */
export async function seedTenant({ name = 'Test Co', code = 'TEST' } = {}) {
  const company = await Company.create({ name, code });

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

/**
 * What the database actually holds, for when a sign-in fails inexplicably.
 *
 * A fixture that reports "Sign-in failed: 403 ROLE_DISABLED" says only that
 * `user.role` did not populate to an ACTIVE role. It does not say whether the
 * role row is missing, disabled, or referenced by an id that no longer exists —
 * and those have different causes. Guessing between them wastes a run, so the
 * failure path reads the state and prints it.
 */
async function describeAuthState(email) {
  const roles = await Role.find({}).select('code status tenantId').lean();
  const user = await User.findOne({ email }).select('email status role tenantId deletedAt').lean();
  const referenced = user?.role
    ? await Role.findById(user.role).select('code status').lean()
    : null;

  return {
    rolesInDatabase: roles.map((r) => `${r.code}:${r.status}`),
    user: user
      ? { status: user.status, deletedAt: user.deletedAt, roleId: String(user.role) }
      : 'NO SUCH USER',
    roleTheUserPointsAt: referenced ? `${referenced.code}:${referenced.status}` : 'MISSING',
    companies: await Company.countDocuments({}),
  };
}

/** Logs in and returns { accessToken, cookie, session } for use in requests. */
export async function signIn(email, password = TEST_PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) {
    const state = await describeAuthState(email);
    throw new Error(
      `Sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}\n`
      + `  DATABASE STATE: ${JSON.stringify(state)}`,
    );
  }
  return {
    accessToken: res.body.data.accessToken,
    cookie: res.headers['set-cookie'],
    session: res.body.data.session,
  };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * Retries a request that came back 409 TRANSACTION_CONFLICT.
 *
 * This honours the contract the API states: that status carries the message
 * "The operation could not be completed due to concurrent activity. Please
 * retry." A client that does not retry is not exercising the documented
 * behaviour, and a test client is a client.
 *
 * It is NOT an explanation. Under Docker on Windows a majority write costs
 * 50–160ms and these transactions are idle ~93% of their lifetime, so conflicts
 * escape the service's own retries far more often than they should — and mongod
 * logs no aborted transaction when they do, which means the driver is sending a
 * txnNumber the server never opened. That root cause is still open and is
 * recorded as such in docs/PHASE-8.md. This helper stops a known-transient
 * infrastructure effect from masking the assertions underneath it; it does not
 * make the effect acceptable.
 */
export async function retryOnConflict(send, { attempts = 4 } = {}) {
  let last;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await send();
    if (last.body?.code !== 'TRANSACTION_CONFLICT') return last;
    await new Promise((r) => setTimeout(r, Math.random() * 100 * attempt));
  }

  return last;
}

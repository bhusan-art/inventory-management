import mongoose from 'mongoose';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Company } from '../../src/models/Company.js';
import { Role } from '../../src/models/Role.js';
import { User } from '../../src/models/User.js';
import { SYSTEM_ROLES } from '../../src/constants/roles.js';
import { Vendor } from '../../src/models/Vendor.js';
import { app, resetDatabase, seedTenant, createUser, signIn, auth } from '../helpers/fixtures.js';

/**
 * PHASE 1 EXIT CRITERION — the role × endpoint × field matrix.
 *
 * This is the suite that must never be skipped to ship a phase. Every phase
 * adds its endpoints to ENDPOINTS below, and every role is asserted against
 * every one of them. A route added without a registered permission fails here
 * rather than in production.
 *
 * The assertion is deliberately "allowed vs denied", not "200 vs 403": a
 * permitted request may legitimately 404 or 422 on fixture data. What matters
 * is that a denied request never gets past authorization.
 */
const ROLE_CODES = Object.keys(SYSTEM_ROLES);

/**
 * Each entry: the request, and which permission(s) it requires. Expected
 * access is derived from the role definitions rather than hand-written, so the
 * matrix cannot drift away from the seeded roles — and changing a role's
 * permissions changes this test's expectations automatically.
 */
const ENDPOINTS = [
  { name: 'list users',        method: 'get',    path: '/api/v1/users',            requires: ['VIEW_USER'] },
  { name: 'create user',       method: 'post',   path: '/api/v1/users',            requires: ['CREATE_USER'], body: {} },
  { name: 'update user',       method: 'put',    path: '/api/v1/users/:userId',    requires: ['UPDATE_USER'], body: { fullName: 'Changed Name' } },
  { name: 'delete user',       method: 'delete', path: '/api/v1/users/:userId',    requires: ['DELETE_USER'] },
  { name: 'set user status',   method: 'patch',  path: '/api/v1/users/:userId/status', requires: ['UPDATE_USER'], body: { status: 'INACTIVE' } },
  { name: 'set user scope',    method: 'patch',  path: '/api/v1/users/:userId/scope',  requires: ['UPDATE_USER'], body: { warehouseIds: [] } },
  { name: 'reset user password', method: 'post', path: '/api/v1/users/:userId/reset-password', requires: ['UPDATE_USER'] },
  { name: 'list roles',        method: 'get',    path: '/api/v1/roles',            requires: ['VIEW_ROLE'] },
  { name: 'create role',       method: 'post',   path: '/api/v1/roles',            requires: ['CREATE_ROLE'], body: {} },
  { name: 'update role',       method: 'put',    path: '/api/v1/roles/:roleId',    requires: ['UPDATE_ROLE'], body: { description: 'x' } },
  { name: 'delete role',       method: 'delete', path: '/api/v1/roles/:roleId',    requires: ['DELETE_ROLE'] },
  { name: 'list permissions',  method: 'get',    path: '/api/v1/permissions',      requires: ['VIEW_ROLE'] },

  // ---- Phase 2: master data ----
  { name: 'list products',     method: 'get',    path: '/api/v1/products',         requires: ['VIEW_PRODUCT'] },
  { name: 'create product',    method: 'post',   path: '/api/v1/products',         requires: ['CREATE_PRODUCT'], body: {} },
  { name: 'update product',    method: 'put',    path: '/api/v1/products/:masterId', requires: ['UPDATE_PRODUCT'], body: { name: 'Changed' } },
  { name: 'delete product',    method: 'delete', path: '/api/v1/products/:masterId', requires: ['DELETE_PRODUCT'] },
  { name: 'import products',   method: 'post',   path: '/api/v1/products/import',  requires: ['CREATE_PRODUCT'], body: { csv: 'name\n' } },
  { name: 'list categories',   method: 'get',    path: '/api/v1/categories',       requires: ['VIEW_CATEGORY'] },
  { name: 'create category',   method: 'post',   path: '/api/v1/categories',       requires: ['CREATE_CATEGORY'], body: {} },
  { name: 'list brands',       method: 'get',    path: '/api/v1/brands',           requires: ['VIEW_CATEGORY'] },
  { name: 'list warehouses',   method: 'get',    path: '/api/v1/warehouses',       requires: ['VIEW_WAREHOUSE'] },
  { name: 'create warehouse',  method: 'post',   path: '/api/v1/warehouses',       requires: ['CREATE_WAREHOUSE'], body: {} },
  { name: 'list vendors',      method: 'get',    path: '/api/v1/vendors',          requires: ['VIEW_VENDOR'] },
  { name: 'create vendor',     method: 'post',   path: '/api/v1/vendors',          requires: ['CREATE_VENDOR'], body: {} },
  { name: 'view vendor bank',  method: 'get',    path: '/api/v1/vendors/:masterId/bank-details', requires: ['VIEW_VENDOR', 'VIEW_VENDOR_BANK_DETAILS'] },
  { name: 'list customers',    method: 'get',    path: '/api/v1/customers',        requires: ['VIEW_CUSTOMER'] },
  { name: 'create customer',   method: 'post',   path: '/api/v1/customers',        requires: ['CREATE_CUSTOMER'], body: {} },
];

const DENIED_STATUSES = [401, 403];

let context = {};

beforeAll(async () => {
  await connectDatabase({ retries: 3, delayMs: 1000 });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  const { company, roles } = await seedTenant();

  const tokens = {};
  for (const code of ROLE_CODES) {
    await createUser({ company, role: roles[code], email: `${code.toLowerCase()}@test.local` });
    tokens[code] = (await signIn(`${code.toLowerCase()}@test.local`)).accessToken;
  }

  // A separate target so a role acting on itself does not trip the
  // self-modification guard and mask an authorization result.
  const target = await createUser({ company, role: roles.VIEWER, email: 'target@test.local' });

  // A master record the master-data endpoints can act on. Vendor is used for
  // every :masterId route: the routes only need a well-formed id that exists,
  // and authorization is decided before the handler ever loads it.
  const vendor = await Vendor.create({
    tenantId: company._id, vendorName: 'Matrix Vendor', vendorCode: 'V-MATRIX',
  });

  context = {
    company, roles, tokens,
    targetUserId: String(target._id),
    targetRoleId: String(roles.VIEWER._id),
    masterId: String(vendor._id),
  };
});

function resolvePath(path) {
  return path
    .replace(':userId', context.targetUserId)
    .replace(':roleId', context.targetRoleId)
    .replace(':masterId', context.masterId);
}

describe('role × endpoint permission matrix', () => {
  for (const roleCode of ROLE_CODES) {
    describe(roleCode, () => {
      for (const endpoint of ENDPOINTS) {
        const shouldAllow = endpoint.requires.every((p) =>
          SYSTEM_ROLES[roleCode].permissions.includes(p),
        );

        it(`${shouldAllow ? 'may' : 'may NOT'} ${endpoint.name}`, async () => {
          const req = request(app)[endpoint.method](resolvePath(endpoint.path))
            .set(auth(context.tokens[roleCode]));

          const res = endpoint.body ? await req.send(endpoint.body) : await req;

          if (shouldAllow) {
            expect(DENIED_STATUSES).not.toContain(res.status);
          } else {
            expect(DENIED_STATUSES).toContain(res.status);
          }
        });
      }
    });
  }
});

describe('unauthenticated access', () => {
  for (const endpoint of ENDPOINTS) {
    it(`rejects ${endpoint.name} with no token`, async () => {
      const req = request(app)[endpoint.method](resolvePath(endpoint.path));
      const res = endpoint.body ? await req.send(endpoint.body) : await req;
      expect(res.status).toBe(401);
    });
  }
});

describe('restricted field enforcement', () => {
  it('omits the phone number for roles without VIEW_CONTACT_DETAILS', async () => {
    await User.updateOne({ email: 'target@test.local' }, { phone: '+919999999999' });

    // Inventory Manager can read users but not contact details.
    const res = await request(app)
      .get(`/api/v1/users/${context.targetUserId}`)
      .set(auth(context.tokens.INVENTORY_MANAGER));

    expect(res.status).toBe(200);
    expect('phone' in res.body.data).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('9999999999');
  });

  it('includes the phone number for roles that hold VIEW_CONTACT_DETAILS', async () => {
    await User.updateOne({ email: 'target@test.local' }, { phone: '+919999999999' });

    const res = await request(app)
      .get(`/api/v1/users/${context.targetUserId}`)
      .set(auth(context.tokens.ADMIN));

    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('+919999999999');
  });

  it('rejects sorting by a restricted field instead of silently ignoring it', async () => {
    // Silently dropping the parameter would make a probe look like a normal
    // empty result, hiding exactly the behaviour worth noticing.
    const res = await request(app)
      .get('/api/v1/users?sort=phone:asc')
      .set(auth(context.tokens.INVENTORY_MANAGER));

    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe('RESTRICTED_FIELD_ACCESS_DENIED');
  });

  it('rejects filtering by a restricted field', async () => {
    const res = await request(app)
      .get('/api/v1/users?filter[phone]=999')
      .set(auth(context.tokens.INVENTORY_MANAGER));

    expect(res.status).toBe(403);
  });

  it('allows the same sort for a role that holds the permission', async () => {
    const res = await request(app)
      .get('/api/v1/users?sort=phone:asc')
      .set(auth(context.tokens.ADMIN));

    expect(res.status).toBe(200);
  });
});

describe('privilege escalation', () => {
  it('stops an Admin creating a Super Admin', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(auth(context.tokens.ADMIN))
      .send({
        fullName: 'Escalated User',
        email: 'escalated@test.local',
        role: String(context.roles.SUPER_ADMIN._id),
      });

    expect(res.status).toBe(403);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('stops a role being created with permissions the creator lacks', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set(auth(context.tokens.ADMIN))
      .send({
        name: 'Shadow Admin',
        code: 'SHADOW_ADMIN',
        rank: 70,
        permissions: ['MANAGE_SUPER_ADMIN'],
      });

    expect(res.status).toBe(403);
  });

  it('stops a role being created at or above the creator’s own rank', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set(auth(context.tokens.ADMIN))
      .send({ name: 'Peer Role', code: 'PEER_ROLE', rank: 90, permissions: [] });

    expect(res.status).toBe(403);
  });

  it('lets Super Admin do what Admin cannot', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set(auth(context.tokens.SUPER_ADMIN))
      .send({ name: 'Elevated', code: 'ELEVATED', rank: 70, permissions: ['MANAGE_SUPER_ADMIN'] });

    expect(res.status).toBe(201);
  });

  it('stops a user changing their own status', async () => {
    const selfId = (await User.findOne({ email: 'admin@test.local' }))._id;
    const res = await request(app)
      .patch(`/api/v1/users/${selfId}/status`)
      .set(auth(context.tokens.ADMIN))
      .send({ status: 'INACTIVE' });

    expect(res.status).toBe(422);
  });

  it('protects system roles from deletion', async () => {
    const res = await request(app)
      .delete(`/api/v1/roles/${context.roles.VIEWER._id}`)
      .set(auth(context.tokens.SUPER_ADMIN));

    expect(res.status).toBe(422);
  });
});

describe('tenant isolation', () => {
  it('hides records belonging to another company', async () => {
    // The tenant hook is single-company today, but the enforcement path is
    // live and tested now — retrofitting it after Phase 8 would be a rewrite.
    const other = await Company.create({ name: 'Other Co', code: 'OTHER' });
    const otherRole = await Role.create({
      tenantId: other._id, code: 'ADMIN', name: 'Admin',
      permissions: SYSTEM_ROLES.ADMIN.permissions, rank: 80, isSystem: true,
    });
    const foreignUser = await createUser({
      company: other, role: otherRole, email: 'foreign@other.local',
    });

    const list = await request(app).get('/api/v1/users?limit=200').set(auth(context.tokens.SUPER_ADMIN));
    const emails = list.body.data.map((u) => u.email);
    expect(emails).not.toContain('foreign@other.local');

    const direct = await request(app)
      .get(`/api/v1/users/${foreignUser._id}`)
      .set(auth(context.tokens.SUPER_ADMIN));

    // 404, not 403: confirming the record exists is itself a disclosure.
    expect(direct.status).toBe(404);
  });
});

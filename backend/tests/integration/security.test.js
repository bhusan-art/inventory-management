import jwt from 'jsonwebtoken';
import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { Vendor } from '../../src/models/Vendor.js';
import { Product } from '../../src/models/Product.js';
import { Category } from '../../src/models/Category.js';
import { User } from '../../src/models/User.js';
import { SYSTEM_ROLES } from '../../src/constants/roles.js';
import { clearAuthCache } from '../../src/middleware/authenticate.js';
import {
  app, resetDatabase, seedTenant, createUser, signIn, auth, TEST_PASSWORD,
} from '../helpers/fixtures.js';

/**
 * PHASE 12 — the consolidated security pass.
 *
 * Every earlier phase tested that its own feature refuses the wrong role. None
 * of them tested the things that cut ACROSS features: a forged token, another
 * tenant's record id, an operator in a query value, a field the client was
 * never meant to set. Those are the failures that do not belong to any one
 * module, which is exactly why no module's suite covers them.
 *
 * The rule for this file: assert the OUTCOME, not the mechanism. "Tenant B
 * cannot read tenant A's vendor" must hold whether the protection lives in a
 * filter, a scope check or a middleware — and must keep holding when that
 * moves.
 */

let A;
let B;
let adminA;
let adminB;
let viewerA;
let vendorA;
let productA;

beforeAll(async () => {
  await connectDatabase();
  await resetDatabase();

  A = await seedTenant({ name: 'Tenant A', code: 'TA' });
  B = await seedTenant({ name: 'Tenant B', code: 'TB' });

  await createUser({ company: A.company, role: A.roles.ADMIN, email: 'admin-a@test.com' });
  await createUser({ company: B.company, role: B.roles.ADMIN, email: 'admin-b@test.com' });
  await createUser({ company: A.company, role: A.roles.VIEWER, email: 'viewer-a@test.com' });

  adminA = await signIn('admin-a@test.com');
  adminB = await signIn('admin-b@test.com');
  viewerA = await signIn('viewer-a@test.com');

  vendorA = await Vendor.create({
    tenantId: A.company._id,
    vendorName: 'Tenant A Supplies',
    vendorCode: 'V-TA-1',
    phone: '+919876543210',
  });

  const categoryA = await Category.create({
    tenantId: A.company._id, name: 'Tenant A Parts', code: 'TAP',
  });

  productA = await Product.create({
    tenantId: A.company._id,
    name: 'Tenant A Widget',
    sku: 'SKU-A-1',
    productCode: 'PC-A-1',
    category: categoryA._id,
    productType: 'NON_SERIALIZED',
  });
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('authentication cannot be bypassed', () => {
  it('refuses a request with no token', async () => {
    const res = await request(app).get('/api/v1/vendors');
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_MISSING']);
  });

  it.each([
    ['wrong scheme', 'Token abcdef'],
    ['no scheme', 'abcdef'],
    ['scheme with no token', 'Bearer'],
    ['scheme with blank token', 'Bearer    '],
  ])('refuses a malformed Authorization header (%s)', async (_label, header) => {
    const res = await request(app).get('/api/v1/vendors').set('Authorization', header);
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_MISSING']);
  });

  it('refuses a token that is not a JWT at all', async () => {
    const res = await request(app).get('/api/v1/vendors').set(auth('not-a-token'));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('refuses a token signed with a different secret', async () => {
    // The whole security model rests on this one check.
    const forged = jwt.sign(
      { sub: String(adminA.session?.userId ?? '0'.repeat(24)), tid: String(A.company._id), perms: ['*'], tv: 0 },
      'an-attacker-chosen-secret',
      { issuer: 'ims', audience: 'ims-api', expiresIn: '15m' },
    );
    const res = await request(app).get('/api/v1/vendors').set(auth(forged));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('refuses an unsigned token claiming alg:none', async () => {
    // The classic JWT library failure. jsonwebtoken is not vulnerable, but the
    // assertion costs nothing and the day it regresses is the day it matters.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      sub: '0'.repeat(24), tid: String(A.company._id), perms: ['*'], tv: 0, iss: 'ims', aud: 'ims-api',
    })).toString('base64url');

    const res = await request(app).get('/api/v1/vendors').set(auth(`${header}.${body}.`));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('refuses an expired token', async () => {
    const expired = jwt.sign(
      { sub: '0'.repeat(24), tid: String(A.company._id), perms: ['*'], tv: 0 },
      process.env.JWT_SECRET,
      { issuer: 'ims', audience: 'ims-api', expiresIn: '-1s' },
    );
    const res = await request(app).get('/api/v1/vendors').set(auth(expired));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_EXPIRED']);
  });

  it('refuses a token minted for a different audience or issuer', async () => {
    const wrongAudience = jwt.sign(
      { sub: '0'.repeat(24), tid: String(A.company._id), perms: ['*'], tv: 0 },
      process.env.JWT_SECRET,
      { issuer: 'ims', audience: 'some-other-service', expiresIn: '15m' },
    );
    const res = await request(app).get('/api/v1/vendors').set(auth(wrongAudience));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_INVALID']);
  });

  it('refuses a token for a user that no longer exists', async () => {
    const ghost = jwt.sign(
      { sub: '0'.repeat(24), tid: String(A.company._id), rid: String(A.roles.ADMIN._id), rc: 'ADMIN', perms: ['*'], tv: 0 },
      process.env.JWT_SECRET,
      { issuer: 'ims', audience: 'ims-api', expiresIn: '15m' },
    );
    const res = await request(app).get('/api/v1/vendors').set(auth(ghost));
    expect([res.status, res.body.code]).toEqual([401, 'USER_NOT_FOUND']);
  });
});

describe('a valid token stops working when the account changes', () => {
  /**
   * The point of `tokenVersion`. Access tokens carry a permission snapshot, so
   * without this a demoted or sacked user keeps their old rights until the
   * token expires — fifteen minutes of access granted by a revoked account.
   */
  it('rejects the token after the user is deactivated', async () => {
    await createUser({ company: A.company, role: A.roles.WAREHOUSE_OPERATOR, email: 'soon-gone@test.com' });
    const session = await signIn('soon-gone@test.com');

    const before = await request(app).get('/api/v1/vendors').set(auth(session.accessToken));
    expect(before.status).toBe(200);

    await User.updateOne({ email: 'soon-gone@test.com' }, { status: 'INACTIVE' });
    clearAuthCache(); // the real cache expires in 5s; the test does not wait

    const after = await request(app).get('/api/v1/vendors').set(auth(session.accessToken));
    expect([after.status, after.body.code]).toEqual([403, 'ACCOUNT_INACTIVE']);
  });

  it('rejects the token after the account is soft-deleted', async () => {
    await createUser({ company: A.company, role: A.roles.WAREHOUSE_OPERATOR, email: 'soon-deleted@test.com' });
    const session = await signIn('soon-deleted@test.com');

    await User.updateOne({ email: 'soon-deleted@test.com' }, { deletedAt: new Date() });
    clearAuthCache();

    const res = await request(app).get('/api/v1/vendors').set(auth(session.accessToken));
    expect([res.status, res.body.code]).toEqual([401, 'USER_NOT_FOUND']);
  });

  it('rejects the token after tokenVersion is bumped', async () => {
    await createUser({ company: A.company, role: A.roles.WAREHOUSE_OPERATOR, email: 'soon-stale@test.com' });
    const session = await signIn('soon-stale@test.com');

    await User.updateOne({ email: 'soon-stale@test.com' }, { $inc: { tokenVersion: 1 } });
    clearAuthCache();

    const res = await request(app).get('/api/v1/vendors').set(auth(session.accessToken));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_STALE']);
  });

  it('invalidates every session when the password changes', async () => {
    await createUser({ company: A.company, role: A.roles.WAREHOUSE_OPERATOR, email: 'changer@test.com' });
    const first = await signIn('changer@test.com');
    const second = await signIn('changer@test.com');

    const changed = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(first.accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'ADifferentPassword456' });
    expect(changed.status).toBe(200);

    clearAuthCache();

    // The OTHER session must die too. A password change is what a user does
    // after they suspect a compromise, so leaving the attacker's session alive
    // defeats the purpose of offering the feature.
    const res = await request(app).get('/api/v1/vendors').set(auth(second.accessToken));
    expect([res.status, res.body.code]).toEqual([401, 'TOKEN_STALE']);
  });
});

describe('one tenant cannot reach another tenant (IDOR)', () => {
  /**
   * Every query in the system filters on `tenantId`. Until a second tenant
   * exists, none of those filters are tested — the suite passes identically
   * whether the filter is there or not.
   */
  it('refuses to read another tenant record by id', async () => {
    const res = await request(app)
      .get(`/api/v1/vendors/${vendorA._id}`)
      .set(auth(adminB.accessToken));
    expect(res.status).toBe(404);
  });

  it('refuses to update another tenant record', async () => {
    const res = await request(app)
      .put(`/api/v1/vendors/${vendorA._id}`)
      .set(auth(adminB.accessToken))
      .send({ vendorName: 'Renamed by tenant B' });
    expect(res.status).toBe(404);

    const unchanged = await Vendor.findById(vendorA._id).lean();
    expect(unchanged.vendorName).toBe('Tenant A Supplies');
  });

  it('refuses to delete another tenant record', async () => {
    const res = await request(app)
      .delete(`/api/v1/products/${productA._id}`)
      .set(auth(adminB.accessToken));
    expect(res.status).toBe(404);

    const still = await Product.findOne({ _id: productA._id, deletedAt: null }).lean();
    expect(still).not.toBeNull();
  });

  it('404s rather than 403s, so the id is not confirmed to exist', async () => {
    // A 403 on a real id and a 404 on a fake one is an existence oracle: it
    // lets an outsider enumerate a competitor's record ids.
    const real = await request(app).get(`/api/v1/vendors/${vendorA._id}`).set(auth(adminB.accessToken));
    const fake = await request(app).get(`/api/v1/vendors/${'a'.repeat(24)}`).set(auth(adminB.accessToken));
    expect(real.status).toBe(fake.status);
  });

  it('never lists another tenant records', async () => {
    const res = await request(app).get('/api/v1/vendors?limit=200').set(auth(adminB.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((v) => v.vendorName)).not.toContain('Tenant A Supplies');
  });

  it('refuses a token whose tenant claim was swapped', async () => {
    // Forging the tenant is cheaper than guessing ids, so the claim is checked
    // against the user record rather than trusted.
    const [, payload] = adminA.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

    const swapped = jwt.sign(
      { ...claims, tid: String(B.company._id), iat: undefined, exp: undefined, iss: undefined, aud: undefined },
      process.env.JWT_SECRET,
      { issuer: 'ims', audience: 'ims-api', expiresIn: '15m' },
    );

    const res = await request(app).get('/api/v1/vendors').set(auth(swapped));
    expect([res.status, res.body.code]).toEqual([401, 'TENANT_MISMATCH']);
  });
});

describe('a client cannot grant itself permissions it was not given', () => {
  it('ignores a tenantId supplied in the body', async () => {
    // Mass assignment: if `tenantId` were taken from the request, any tenant
    // could write records into any other.
    const res = await request(app)
      .post('/api/v1/vendors')
      .set(auth(adminB.accessToken))
      .send({ vendorName: 'Planted', vendorCode: 'V-PLANT-1', tenantId: String(A.company._id) });

    expect(res.status).toBe(201);
    const created = await Vendor.findById(res.body.data.id).lean();
    expect(String(created.tenantId)).toBe(String(B.company._id));
  });

  it('refuses a permission escalation through the token payload', async () => {
    // `perms` is read FROM the token on the fast path, so the signature is the
    // only thing stopping a client from writing its own permission list. A
    // forged list is caught at the signature; a list forged into a legitimately
    // signed token is impossible without the secret. What this proves is that
    // the server does not accept permissions from anywhere else — a header, a
    // query parameter or a body field.
    const res = await request(app)
      .get('/api/v1/users?permissions=*')
      .set(auth(viewerA.accessToken))
      .set('X-Permissions', '*')
      .set('X-Role', 'SUPER_ADMIN');

    expect([res.status, res.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('refuses a role change the actor does not rank above', async () => {
    const res = await request(app)
      .put(`/api/v1/users/${(await User.findOne({ email: 'admin-a@test.com' }).lean())._id}`)
      .set(auth(viewerA.accessToken))
      .send({ fullName: 'Hijacked' });

    expect(res.status).toBe(403);
  });
});

describe('query operators in values are data, not instructions', () => {
  /**
   * The NoSQL injection surface. `{ email: { $ne: null } }` as a login body is
   * the canonical authentication bypass, and `?status[$ne]=x` the canonical
   * filter bypass — Express parses bracket notation into a nested object for
   * free, so the operator arrives already shaped.
   */
  it('refuses an object where a login expects a string', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: { $ne: null }, password: { $ne: null } });

    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty('data.accessToken');
  });

  it('refuses a regex operator smuggled into a login', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: { $regex: '.*' }, password: TEST_PASSWORD });

    expect(res.status).toBe(400);
  });

  it('treats a bracket-notation operator in a filter as a value, not an operator', async () => {
    const res = await request(app)
      .get('/api/v1/vendors?vendorName[$ne]=nothing&limit=200')
      .set(auth(adminB.accessToken));

    // Whatever it does — reject it or match nothing — it must not become a
    // query that returns rows the filter was meant to exclude.
    expect([400, 422, 200]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.data.map((v) => v.vendorName)).not.toContain('Tenant A Supplies');
    }
  });

  it('does not let an operator in a search term widen the result set', async () => {
    const res = await request(app)
      .get(`/api/v1/vendors?search=${encodeURIComponent('.*')}&limit=200`)
      .set(auth(adminB.accessToken));

    expect(res.status).toBe(200);
    // Search is a regex internally. An unescaped `.*` would match everything
    // within the tenant, which is how a "search" becomes a dump.
    expect(res.body.data.map((v) => v.vendorName)).not.toContain('Tenant A Supplies');
  });

  it('rejects a malformed id without leaking a stack trace', async () => {
    const res = await request(app).get('/api/v1/vendors/not-an-objectid').set(auth(adminA.accessToken));

    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/at \/|node_modules|\.js:\d+/);
  });
});

describe('the transport is hardened', () => {
  it('does not announce the server technology', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the headers that stop a browser guessing', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('refuses a request body larger than the limit', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(2 * 1024 * 1024) }));

    expect(res.status).toBe(413);
  });

  it('answers an unknown path with the standard error shape', async () => {
    const res = await request(app).get('/api/v1/no-such-thing').set(auth(adminA.accessToken));
    expect(res.status).toBe(404);
    expect(typeof res.body.code).toBe('string');
  });
});

describe('error replies never carry internals', () => {
  it('gives every failure a machine code to match on', async () => {
    const failures = await Promise.all([
      request(app).get('/api/v1/vendors'),
      request(app).get('/api/v1/vendors').set(auth('garbage')),
      request(app).get('/api/v1/users').set(auth(viewerA.accessToken)),
      request(app).get(`/api/v1/vendors/${'a'.repeat(24)}`).set(auth(adminA.accessToken)),
      request(app).post('/api/v1/auth/login').send({ email: 'nope' }),
    ]);

    for (const res of failures) {
      expect([res.status, typeof res.body.code]).toEqual([res.status, 'string']);
      expect(res.body.success).toBe(false);
    }
  });

  it('does not say whether an email exists when a sign-in fails', async () => {
    const unknown = await request(app).post('/api/v1/auth/login')
      .send({ email: 'nobody@test.com', password: TEST_PASSWORD });
    const wrongPassword = await request(app).post('/api/v1/auth/login')
      .send({ email: 'admin-a@test.com', password: 'DefinitelyWrong123' });

    // Differing replies turn the login form into a user directory.
    expect([unknown.status, unknown.body.code]).toEqual([wrongPassword.status, wrongPassword.body.code]);
  });

  it('never returns a password hash', async () => {
    const res = await request(app).get('/api/v1/users?limit=200').set(auth(adminA.accessToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('keeps the refresh token out of the response body', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'admin-a@test.com', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    // HttpOnly cookie only. In the body it would be readable by any script on
    // the page, which is the whole reason the cookie exists.
    expect(JSON.stringify(res.body)).not.toMatch(/refreshToken/);
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
  });
});

describe('every role is still bounded by its permissions', () => {
  it('denies a viewer every write across the modules', async () => {
    const writes = [
      ['post', '/api/v1/vendors', { vendorName: 'Nope', vendorCode: 'V-NOPE' }],
      ['post', '/api/v1/products', { name: 'Nope', sku: 'SKU-NOPE' }],
      ['post', '/api/v1/users', { email: 'nope@test.com' }],
      ['post', '/api/v1/warehouses', { name: 'Nope', code: 'WH-NOPE' }],
      ['delete', `/api/v1/vendors/${vendorA._id}`, undefined],
    ];

    for (const [method, path, body] of writes) {
      const req = request(app)[method](path).set(auth(viewerA.accessToken));
      const res = await (body ? req.send(body) : req);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it('confirms VIEWER holds no permission containing CREATE, UPDATE or DELETE', async () => {
    // Belt and braces on the role definitions themselves, so a permission
    // added to VIEWER by accident fails here and not in a customer's data.
    const viewer = SYSTEM_ROLES.VIEWER.permissions;
    expect(viewer.filter((p) => /^(CREATE|UPDATE|DELETE)_/.test(p))).toEqual([]);
  });
});

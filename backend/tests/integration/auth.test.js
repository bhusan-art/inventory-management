import request from 'supertest';
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { User } from '../../src/models/User.js';
import { RefreshToken } from '../../src/models/RefreshToken.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import {
  app, resetDatabase, seedTenant, createUser, signIn, auth, TEST_PASSWORD,
} from '../helpers/fixtures.js';

let company;
let roles;
let adminUser;

beforeAll(async () => {
  await connectDatabase({ retries: 3, delayMs: 1000 });
});

afterAll(async () => {
  await mongooseDropAndClose();
});

async function mongooseDropAndClose() {
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
}

beforeEach(async () => {
  await resetDatabase();
  ({ company, roles } = await seedTenant());
  adminUser = await createUser({ company, role: roles.ADMIN, email: 'admin@test.local' });
});

describe('POST /auth/login', () => {
  it('signs in with valid credentials and returns the permission set', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@test.local', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.session.permissions).toContain('VIEW_PRODUCT');
    expect(res.body.data.session.role.code).toBe('ADMIN');
    // Refresh token must be HttpOnly and scoped — never readable by JS.
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/ims_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('never returns the password hash or token version', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@test.local', password: TEST_PASSWORD });

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/passwordHash/);
    expect(serialized).not.toMatch(/tokenVersion/);
  });

  it('gives the same response for a wrong password and an unknown account', async () => {
    // Distinguishing the two is a free account-enumeration oracle.
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@test.local', password: 'WrongPassword123' });

    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('locks the account after five failed attempts', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'admin@test.local', password: 'WrongPassword123' });
    }

    const locked = await User.findById(adminUser._id);
    expect(locked.lockedUntil).toBeTruthy();
    expect(locked.lockedUntil.getTime()).toBeGreaterThan(Date.now());

    // Correct credentials are refused while locked, with the same message.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@test.local', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses an inactive account', async () => {
    await User.updateOne({ _id: adminUser._id }, { status: 'INACTIVE' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@test.local', password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.errors?.[0]?.code ?? res.body.message).toBeTruthy();
  });

  it('writes an audit entry on success', async () => {
    await signIn('admin@test.local');
    const entry = await AuditLog.findOne({ action: 'LOGIN_SUCCESS' });
    expect(entry).toBeTruthy();
    expect(String(entry.recordId)).toBe(String(adminUser._id));
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token on every use', async () => {
    const { cookie } = await signIn('admin@test.local');

    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);

    const newCookie = res.headers['set-cookie'].join(';');
    expect(newCookie).not.toBe(cookie.join(';'));

    const tokens = await RefreshToken.find({ user: adminUser._id }).sort({ createdAt: 1 });
    expect(tokens).toHaveLength(2);
    expect(tokens[0].usedAt).toBeTruthy();
    expect(tokens[1].familyId).toBe(tokens[0].familyId);
  });

  it('detects reuse, revokes the family, and invalidates every access token', async () => {
    const { cookie, accessToken } = await signIn('admin@test.local');

    // Legitimate rotation.
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);

    // The captured copy is replayed.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.errors?.[0]?.code ?? replay.body.message).toBeDefined();

    const live = await RefreshToken.countDocuments({ user: adminUser._id, revokedAt: null });
    expect(live).toBe(0);

    const critical = await AuditLog.findOne({ action: 'SECURITY_TOKEN_REUSE' });
    expect(critical?.severity).toBe('CRITICAL');

    // The access token issued before the breach must also stop working.
    const after = await request(app).get('/api/v1/auth/me').set(auth(accessToken));
    expect(after.status).toBe(401);
  });

  it('rejects a refresh with no cookie', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('token invalidation', () => {
  it('rejects an access token immediately after the user is deactivated', async () => {
    const { accessToken } = await signIn('admin@test.local');
    await request(app).get('/api/v1/auth/me').set(auth(accessToken)).expect(200);

    // Deactivation bumps tokenVersion; the middleware compares it per request,
    // so access ends now rather than when the 15-minute token expires.
    await User.updateOne({ _id: adminUser._id }, { status: 'INACTIVE', $inc: { tokenVersion: 1 } });
    const { clearAuthCache } = await import('../../src/middleware/authenticate.js');
    clearAuthCache();

    const res = await request(app).get('/api/v1/auth/me').set(auth(accessToken));
    expect([401, 403]).toContain(res.status);
  });

  it('rejects a malformed or forged token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set(auth('not.a.jwt'));
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password and revokes all sessions', async () => {
    const { accessToken } = await signIn('admin@test.local');

    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'BrandNewPassword456' });

    expect(res.status).toBe(200);

    const live = await RefreshToken.countDocuments({ user: adminUser._id, revokedAt: null });
    expect(live).toBe(0);

    await signIn('admin@test.local', 'BrandNewPassword456');
  });

  it('rejects a wrong current password', async () => {
    const { accessToken } = await signIn('admin@test.local');
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(accessToken))
      .send({ currentPassword: 'NotThePassword1', newPassword: 'BrandNewPassword456' });
    expect(res.status).toBe(401);
  });

  it('rejects a weak new password', async () => {
    const { accessToken } = await signIn('admin@test.local');
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short1' });
    expect(res.status).toBe(400);
  });

  it('rejects reusing the current password', async () => {
    const { accessToken } = await signIn('admin@test.local');
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set(auth(accessToken))
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(res.status).toBe(422);
  });
});

describe('password reset', () => {
  it('reports the same result whether or not the address exists', async () => {
    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@test.local' });
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.local' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);
  });

  it('completes a reset and invalidates the token afterwards', async () => {
    const start = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@test.local' });
    const token = start.body.data.devResetToken;
    expect(token).toBeTruthy();

    await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'ResetPassword789abc' })
      .expect(200);

    await signIn('admin@test.local', 'ResetPassword789abc');

    // Single use.
    const replay = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'AnotherPassword999' });
    expect(replay.status).toBe(422);
  });
});

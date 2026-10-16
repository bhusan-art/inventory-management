import express from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import errorHandler from '../../src/middleware/errorHandler.js';
import requestContext from '../../src/middleware/requestContext.js';
import { createRateLimiter } from '../../src/middleware/rateLimit.js';
import { RateLimitedError } from '../../src/utils/errors.js';

/**
 * The replies that never reach a route.
 *
 * A rate-limited request is refused by middleware; a malformed or oversized
 * body fails inside `express.json`, before any route or schema has been chosen.
 * Nothing in the suite exercised either path, and both were wrong:
 *
 *   429 — express-rate-limit's `message:` option writes its own response and
 *         skips `errorHandler`, so this was the one reply in the system with no
 *         top-level `code`. ARCHITECTURE.md tells clients to match on `code`
 *         and never on message text; a client doing exactly that got
 *         `undefined` and fell through to a generic failure. Same defect class
 *         as Phase 8's, in the one place Phase 8 did not look.
 *
 *   413 / 400 — a too-large or malformed body came back 500 INTERNAL_ERROR.
 *         That is a client mistake reported as a server fault: it pages
 *         whoever is on call, spends the error budget, and in production
 *         replaces the message with "An unexpected error occurred", so the
 *         caller cannot tell a 2MB upload from a crash.
 *
 * These run without a database because the failure happens before any handler.
 */
const app = createApp();

describe('a refused request still answers in the standard shape', () => {
  it('gives a 429 a top-level code and a requestId', async () => {
    // `force` keeps the production limit in a test run. Previously the limit
    // was `env.isTest ? 100_000 : 5` at the call site, so the real number was
    // unreachable from a test and the 429 path was never executed at all.
    const limited = express();
    limited.use(requestContext);
    limited.use(createRateLimiter({ limit: 1, force: true, message: 'Slow down' }));
    limited.get('/thing', (req, res) => res.json({ ok: true }));
    limited.use(errorHandler);

    const first = await request(limited).get('/thing');
    expect(first.status).toBe(200);

    const second = await request(limited).get('/thing');
    expect([second.status, second.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(second.body.success).toBe(false);
    expect(second.body.message).toBe('Slow down');
    // Traceable. The old hand-written body had no requestId either, so a
    // report of "it just said too many requests" could not be found in a log.
    expect(typeof second.body.requestId).toBe('string');
  });

  it('advertises the limit in the standard headers', async () => {
    const limited = express();
    limited.use(createRateLimiter({ limit: 2, force: true }));
    limited.get('/thing', (req, res) => res.json({ ok: true }));
    limited.use(errorHandler);

    const res = await request(limited).get('/thing');
    // draft-7: a client that can read these can back off rather than retry
    // blindly into the limit.
    expect(res.headers).toHaveProperty('ratelimit');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined(); // legacy headers off
  });

  it('relaxes the limit under test unless asked not to', async () => {
    // Otherwise every suite that makes more than a handful of requests starts
    // failing on the limiter rather than on its subject.
    const relaxed = express();
    relaxed.use(createRateLimiter({ limit: 1 }));
    relaxed.get('/thing', (req, res) => res.json({ ok: true }));
    relaxed.use(errorHandler);

    for (let i = 0; i < 5; i += 1) {
      expect((await request(relaxed).get('/thing')).status).toBe(200);
    }
  });

  it('carries the error through the one handler, not a second shape', () => {
    const error = new RateLimitedError();
    expect([error.statusCode, error.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('a body that cannot be parsed is the client failing, not the server', () => {
  it('answers an oversized body with 413, not 500', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(2 * 1024 * 1024) }));

    expect([res.status, res.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
  });

  it('answers malformed JSON with 400, not 500', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.com",,}');

    expect([res.status, res.body.code]).toEqual([400, 'MALFORMED_BODY']);
  });

  it('does not leak the parser internals to the caller', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/node_modules|body-parser|at \//);
  });

  it('answers an unknown route with a code too', async () => {
    const res = await request(app).get('/api/v1/definitely-not-a-route');
    expect([res.status, res.body.code]).toEqual([404, 'ROUTE_NOT_FOUND']);
  });
});

describe('the transport headers are set', () => {
  it('does not announce the server technology', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('stops a browser guessing the content type or framing the app', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

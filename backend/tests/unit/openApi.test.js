import { createApp } from '../../src/app.js';
import { buildOpenApiDocument, collectRoutes } from '../../src/services/docs/openApiService.js';
import { requirePermission } from '../../src/middleware/authorize.js';
import { ALL_PERMISSION_CODES } from '../../src/constants/permissions.js';

const app = createApp();
const doc = buildOpenApiDocument({ app });
const operations = Object.entries(doc.paths).flatMap(
  ([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);

describe('the permission gate exposes what it requires', () => {
  it('carries its codes on the middleware', () => {
    // The generator reads this. A closure's captured values cannot be
    // recovered from its source, so the gate has to volunteer them.
    const gate = requirePermission('VIEW_PRODUCT', 'VIEW_VENDOR');
    expect(gate.requiredPermissions).toEqual(['VIEW_PRODUCT', 'VIEW_VENDOR']);
  });

  it('freezes them, so a consumer cannot edit the live gate', () => {
    const gate = requirePermission('VIEW_PRODUCT');
    expect(Object.isFrozen(gate.requiredPermissions)).toBe(true);
  });

  it('still refuses an unknown permission at construction', () => {
    expect(() => requirePermission('NOT_A_REAL_PERMISSION')).toThrow();
  });
});

describe('the spec describes the app that is actually running', () => {
  it('finds a substantial number of routes', () => {
    expect(collectRoutes(app).length).toBeGreaterThan(100);
  });

  it('refuses to run without the live app', () => {
    // Building a second app per request created a fresh rate limiter each
    // time, and a circular import besides.
    expect(() => collectRoutes(undefined)).toThrow(/running Express app/);
    expect(() => collectRoutes({})).toThrow();
  });

  it('caches per app rather than regenerating 174 operations per request', () => {
    expect(buildOpenApiDocument({ app })).toBe(buildOpenApiDocument({ app }));
  });

  it('emits clean paths with no regex left in them', () => {
    for (const { path } of operations) {
      expect([path, path.startsWith('/api/')]).toEqual([path, true]);
      // Artefacts of converting Express's mount regexps back into paths.
      expect(path).not.toMatch(/[\\^$?()[\]|]/);
      expect(path).not.toContain('//');
    }
  });

  it('converts Express parameters to OpenAPI ones and declares them', () => {
    const withParams = operations.filter(({ path }) => path.includes('{'));
    expect(withParams.length).toBeGreaterThan(10);

    for (const { path, operation } of withParams) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect([path, operation.parameters.map((p) => p.name)]).toEqual([path, names]);
      for (const parameter of operation.parameters) {
        expect(parameter.in).toBe('path');
        expect(parameter.required).toBe(true);
      }
    }
  });

  it('never contains a colon-style Express parameter', () => {
    for (const { path } of operations) expect(path).not.toMatch(/:/);
  });
});

describe('declared permissions are real and complete', () => {
  it('only ever names permissions that exist', () => {
    const known = new Set(ALL_PERMISSION_CODES);

    for (const { path, operation } of operations) {
      for (const code of operation['x-required-permissions'] ?? []) {
        expect([path, code, known.has(code)]).toEqual([path, code, true]);
      }
    }
  });

  it('inherits a permission applied to a whole router', () => {
    // The audit router gates everything with `router.use(...)`. The first
    // version of the walker missed that and documented these as merely
    // "authenticated" — under-reporting, which is the dangerous direction.
    const auditOps = operations.filter(({ path }) => path.includes('/audit-logs'));
    expect(auditOps.length).toBeGreaterThanOrEqual(4);

    for (const { path, operation } of auditOps) {
      expect([path, operation['x-required-permissions']])
        .toEqual([path, ['VIEW_AUDIT_LOGS']]);
    }
  });

  it('documents per-route gates too', () => {
    const brands = operations.find(({ path, method }) => path === '/api/v1/brands/' && method === 'post');
    expect(brands.operation['x-required-permissions']).toEqual(['CREATE_CATEGORY']);
  });

  it('leaves login open and everything else behind a token', () => {
    const login = operations.find(({ path }) => path.endsWith('/auth/login'));
    expect(login.operation.security).toEqual([]);

    const guarded = operations.filter(({ path }) => !path.includes('/auth/login'));
    for (const { path, operation } of guarded) {
      expect([path, operation.security]).toEqual([path, [{ bearerAuth: [] }]]);
    }
  });

  it('describes most of the surface as permission-gated', () => {
    // A sharp drop here means a router lost its gate, or the walker stopped
    // seeing one.
    const gated = operations.filter(({ operation }) => operation['x-required-permissions']);
    expect(gated.length / operations.length).toBeGreaterThan(0.8);
  });
});

describe('the document is well formed', () => {
  it('declares a version, bearer auth and tags', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(doc.tags.length).toBeGreaterThan(10);
  });

  it('publishes the permission vocabulary alongside the routes', () => {
    expect(doc['x-permissions'].length).toBe(ALL_PERMISSION_CODES.length);
  });

  it('says plainly that bodies are not described', () => {
    // Better an honest partial spec than a complete-looking one that lies.
    expect(doc.info.description).toMatch(/NOT reproduced here/);
  });
});

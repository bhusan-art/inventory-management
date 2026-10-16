import { toTestDatabaseUri } from '../setup.js';

/**
 * These tests exist because the original one-liner would have let
 * `docker compose exec backend npm test` drop the live database.
 *
 * The case that matters is the first one: the host must be kept (otherwise the
 * suite cannot reach Mongo inside Docker) while the database name must not be.
 */
describe('test database guard', () => {
  it('keeps the host and rewrites the database name', () => {
    const url = new URL(toTestDatabaseUri('mongodb://mongo:27017/ims?replicaSet=rs0'));
    expect(url.host).toBe('mongo:27017');
    expect(url.pathname).toBe('/ims_test');
  });

  it('preserves connection options', () => {
    const out = toTestDatabaseUri('mongodb://mongo:27017/ims?replicaSet=rs0&directConnection=true');
    expect(out).toContain('replicaSet=rs0');
    expect(out).toContain('directConnection=true');
  });

  it('leaves an already-test database alone', () => {
    const url = new URL(toTestDatabaseUri('mongodb://localhost:27017/ims_test'));
    expect(url.pathname).toBe('/ims_test');
  });

  it('does not double-suffix on a second pass', () => {
    const once = toTestDatabaseUri('mongodb://mongo:27017/ims');
    expect(new URL(toTestDatabaseUri(once)).pathname).toBe('/ims_test');
  });

  it('refuses a URI with no database name', () => {
    expect(() => toTestDatabaseUri('mongodb://mongo:27017')).toThrow(/no database name/);
    expect(() => toTestDatabaseUri('mongodb://mongo:27017/?replicaSet=rs0')).toThrow(/no database name/);
  });

  it('handles a production-shaped URI with credentials', () => {
    const url = new URL(toTestDatabaseUri('mongodb://user:pass@mongo:27017/ims_production?authSource=admin'));
    expect(url.pathname).toBe('/ims_production_test');
    expect(url.username).toBe('user');
  });
});

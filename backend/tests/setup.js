import { jest } from '@jest/globals';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-value-not-for-production';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-not-for-production';

/**
 * The host is inherited; the DATABASE NAME IS NOT.
 *
 * `?? ` on the whole URI was a loaded gun. Running the suite inside the backend
 * container inherits `MONGODB_URI=mongodb://mongo:27017/ims`, and the first
 * `resetDatabase()` empties every collection in it while `afterAll` drops the
 * database outright. One `docker compose exec backend npm test` would have
 * deleted the live system — no error, no warning, tests passing green.
 *
 * So the host, port and options come from the environment (that part has to, or
 * the suite cannot find Mongo inside Docker) and the database name is rewritten
 * to a `_test` name here. The guard below then refuses to run against anything
 * that is not clearly a test database, because this file is the last thing
 * standing between a typo and somebody's stock history.
 */
const DEFAULT_URI = 'mongodb://localhost:27017/ims_test?replicaSet=rs0&directConnection=true';

export function toTestDatabaseUri(raw) {
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');

  if (!name) throw new Error(`MONGODB_URI has no database name: ${raw}`);

  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

process.env.MONGODB_URI = toTestDatabaseUri(process.env.MONGODB_URI ?? DEFAULT_URI);

if (!new URL(process.env.MONGODB_URI).pathname.endsWith('_test')) {
  throw new Error('Refusing to run the test suite against a non-test database');
}

/**
 * Fail a buffered query in half a second rather than ten.
 *
 * Mongoose queues operations issued before a connection exists and gives up
 * after 10s by default. Unit tests have no database, and some code paths write
 * incidentally — `writeAudit` in particular, which catches and logs its own
 * failures. At the default, nine export tests spent 91 seconds waiting for
 * writes that were never the subject.
 *
 * Integration tests await `connectDatabase` before issuing anything, so
 * nothing there buffers and this does not make them flaky.
 */
mongoose.set('bufferTimeoutMS', 500);

jest.setTimeout(30_000);

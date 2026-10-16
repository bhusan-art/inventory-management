/**
 * Environment configuration.
 *
 * Validated once, at boot, with Zod. If configuration is wrong the process
 * exits immediately with a readable message rather than failing later inside a
 * request handler where the cause is much harder to see.
 */
import { z } from 'zod';

const PLACEHOLDER_SECRETS = new Set([
  'change-me-dev-only',
  'change-me-dev-only-too',
  'secret',
  'changeme',
]);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  CLIENT_URL: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  UPLOAD_PATH: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /**
   * These two were read straight off `process.env` at their call sites.
   *
   * This file claims configuration is "validated once, at boot" — and for
   * these it was not. `DOCUMENT_STORAGE_PATH` is the worse of the pair: a typo
   * means every uploaded document is written somewhere nobody looks, with no
   * error, and the mistake surfaces only when a file is wanted back.
   */
  DOCUMENT_STORAGE_PATH: z.string().default('./storage/documents'),
  /**
   * Serves the generated OpenAPI spec in production. Off by default: a
   * complete list of endpoints with the permission each one demands is a
   * reconnaissance gift, and an internal tool has no need of it in the open.
   */
  DOCS_ENABLED: z.enum(['true', 'false']).default('false'),

  PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${detail}`);
  process.exit(1);
}

const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  clientOrigins: parsed.data.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean),
};

/**
 * Boot-time production guards.
 *
 * Each of these is a misconfiguration that does not announce itself. A weak
 * secret, a CORS origin left at localhost or a database URI with no
 * credentials all start cleanly and work in testing; the first sign of trouble
 * is in the wrong place entirely. Refusing to boot is the only moment anyone
 * is still looking.
 *
 * Collected rather than thrown one at a time, so a first deployment learns
 * everything that is wrong in one attempt instead of one restart per problem.
 */
export function productionConfigProblems(config) {
  if (config.NODE_ENV !== 'production') return [];

  const problems = [];
  const weak = (name, value) => {
    if (PLACEHOLDER_SECRETS.has(value)) problems.push(`${name} is a placeholder value.`);
    else if (value.length < 32) problems.push(`${name} is ${value.length} characters; use at least 32.`);
  };

  weak('JWT_SECRET', config.JWT_SECRET);
  weak('JWT_REFRESH_SECRET', config.JWT_REFRESH_SECRET);

  if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
    problems.push('JWT_SECRET and JWT_REFRESH_SECRET must differ — one leak must not compromise both.');
  }

  // The default is localhost. Left in place, every browser request from the
  // real domain is refused by CORS, which looks like a backend outage.
  if (!process.env.CLIENT_URL) {
    problems.push('CLIENT_URL is unset; it defaults to localhost and CORS will refuse the real site.');
  } else if (config.clientOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    problems.push(`CLIENT_URL still contains a localhost origin: ${config.CLIENT_URL}`);
  }

  if (config.clientOrigins.some((o) => o.startsWith('http://'))) {
    problems.push('A CLIENT_URL origin uses http://; the refresh cookie needs https to be Secure.');
  }

  // The production compose starts mongod with --auth. A URI with no
  // credentials fails at connect time with an authentication error that reads
  // like a database fault rather than a configuration one.
  if (!/\/\/[^/@]+@/.test(config.MONGODB_URI)) {
    problems.push('MONGODB_URI carries no credentials, but production MongoDB runs with --auth.');
  }

  if (!/replicaSet=/.test(config.MONGODB_URI)) {
    problems.push('MONGODB_URI names no replicaSet; transactions are unavailable without one.');
  }

  if (config.LOG_LEVEL === 'silent') {
    problems.push('LOG_LEVEL is silent; an incident would leave no trace.');
  }

  return problems;
}

const problems = productionConfigProblems(env);
if (problems.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

export default env;

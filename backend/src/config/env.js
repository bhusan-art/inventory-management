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

// Two boot-time guards that have each cost real projects a real incident.
if (env.isProduction) {
  if (PLACEHOLDER_SECRETS.has(env.JWT_SECRET) || PLACEHOLDER_SECRETS.has(env.JWT_REFRESH_SECRET)) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start: placeholder JWT secrets in production.');
    process.exit(1);
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start: JWT_SECRET and JWT_REFRESH_SECRET must differ.');
    process.exit(1);
  }
}

export default env;

import { productionConfigProblems } from '../../src/config/env.js';

/**
 * The production guards, exercised.
 *
 * This is code that runs exactly once per deployment and never in development,
 * which makes it the easiest code in the system to get wrong and the hardest
 * to notice. A guard that throws on a *valid* configuration is worse than no
 * guard: it blocks a correct deploy at the worst possible moment, and the
 * instinct under pressure is to delete the check.
 *
 * So both directions are asserted — every problem is caught, and a good
 * configuration passes cleanly.
 */
const GOOD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  CLIENT_URL: 'https://inventory.example.com',
  clientOrigins: ['https://inventory.example.com'],
  MONGODB_URI: 'mongodb://ims:pw@mongo:27017/ims?replicaSet=rs0&authSource=admin',
  LOG_LEVEL: 'info',
};

/**
 * Sets the environment to EXACTLY what the case needs, deleting anything it
 * does not name.
 *
 * The first version merged with `Object.assign` and passed `{}` to mean
 * "CLIENT_URL is unset". Merging does not delete, so it only tested that case
 * on a machine where CLIENT_URL happened to be absent — true in a bare
 * sandbox, false in the Docker container where `.env` sets it. The test
 * therefore passed where it was written and failed where it mattered, which
 * is the worst possible direction for a test about production configuration.
 */
const MANAGED = ['CLIENT_URL'];

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const check = (overrides = {}, envVars = { CLIENT_URL: GOOD.CLIENT_URL }) =>
  withEnv(envVars, () => productionConfigProblems({ ...GOOD, ...overrides }));

describe('a sound production configuration boots', () => {
  it('reports no problems', () => {
    expect(check()).toEqual([]);
  });

  it('says nothing at all outside production', () => {
    // Development runs on localhost with short secrets and no database
    // password by design. Applying these rules there would make the guard
    // something every developer learns to work around.
    expect(productionConfigProblems({ ...GOOD, NODE_ENV: 'development', JWT_SECRET: 'short' })).toEqual([]);
    expect(productionConfigProblems({ ...GOOD, NODE_ENV: 'test', JWT_SECRET: 'short' })).toEqual([]);
  });
});

describe('it refuses the misconfigurations that do not announce themselves', () => {
  it('catches a placeholder secret', () => {
    expect(check({ JWT_SECRET: 'change-me-dev-only' }).join()).toMatch(/JWT_SECRET is a placeholder/);
  });

  it('catches a secret that is merely short', () => {
    // 16 characters passed the schema. That is a weekend of brute force, and
    // the token it signs is the entire authorization model.
    const problems = check({ JWT_SECRET: 'x'.repeat(20) });
    expect(problems.join()).toMatch(/JWT_SECRET is 20 characters/);
  });

  it('catches both secrets being the same', () => {
    const same = 'c'.repeat(40);
    expect(check({ JWT_SECRET: same, JWT_REFRESH_SECRET: same }).join()).toMatch(/must differ/);
  });

  it('catches CLIENT_URL left unset, whatever the host environment has', () => {
    // It defaults to localhost, so every browser request from the real domain
    // is refused by CORS — which presents as a backend outage.
    expect(check({}, {}).join()).toMatch(/CLIENT_URL is unset/);
  });

  it('catches a localhost origin left in the list', () => {
    expect(
      check(
        { CLIENT_URL: 'https://app.example.com,http://localhost:5173', clientOrigins: ['https://app.example.com', 'http://localhost:5173'] },
        { CLIENT_URL: 'https://app.example.com,http://localhost:5173' },
      ).join(),
    ).toMatch(/localhost origin/);
  });

  it('catches a plain-http origin, because the refresh cookie needs Secure', () => {
    expect(
      check(
        { CLIENT_URL: 'http://app.example.com', clientOrigins: ['http://app.example.com'] },
        { CLIENT_URL: 'http://app.example.com' },
      ).join(),
    ).toMatch(/needs https/);
  });

  it('catches a database URI with no credentials', () => {
    expect(
      check({ MONGODB_URI: 'mongodb://mongo:27017/ims?replicaSet=rs0' }).join(),
    ).toMatch(/no credentials/);
  });

  it('catches a database URI with no replica set', () => {
    // Transactions are unavailable on a standalone mongod, and every
    // stock-moving operation in the system depends on them.
    expect(
      check({ MONGODB_URI: 'mongodb://ims:pw@mongo:27017/ims' }).join(),
    ).toMatch(/replicaSet/);
  });

  it('catches logging turned off', () => {
    expect(check({ LOG_LEVEL: 'silent' }).join()).toMatch(/no trace/);
  });

  it('reports every problem at once rather than one per restart', () => {
    const problems = check(
      {
        JWT_SECRET: 'short',
        JWT_REFRESH_SECRET: 'short',
        MONGODB_URI: 'mongodb://mongo:27017/ims',
        LOG_LEVEL: 'silent',
      },
      {},
    );
    // Secret length ×2, identical secrets, CLIENT_URL unset, no credentials,
    // no replica set, silent logging.
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
});

export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 30_000,
  collectCoverageFrom: ['src/**/*.js', '!src/db/seed.js'],
  coverageThreshold: {
    // Raised per phase. Services carry the real logic, so they carry the bar.
    global: { statements: 50, branches: 40, functions: 50, lines: 50 },
  },
};

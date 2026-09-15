import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-value-not-for-production';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-not-for-production';
process.env.MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/ims_test?replicaSet=rs0&directConnection=true';

jest.setTimeout(30_000);

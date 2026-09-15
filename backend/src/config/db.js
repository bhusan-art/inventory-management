import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true); // blocks operator injection via user-supplied filters

let replicaSetVerified = false;

/**
 * Confirms the connected deployment can actually run multi-document
 * transactions.
 *
 * A standalone mongod accepts `startSession()` and then fails on
 * `startTransaction`, so the failure surfaces deep inside a GRN posting rather
 * than at boot. We check the topology explicitly and refuse to start without
 * it, because every stock-moving operation from Phase 3 onward depends on it.
 */
export async function assertReplicaSet() {
  const admin = mongoose.connection.db.admin();
  const info = await admin.command({ hello: 1 });
  const isReplicaSet = Boolean(info.setName);

  if (!isReplicaSet) {
    throw new Error(
      'MongoDB is running standalone. This application requires a replica set ' +
        'for multi-document transactions. In development, start it with ' +
        '`--replSet rs0` and run `rs.initiate()` (docker-compose does this for you).',
    );
  }

  replicaSetVerified = true;
  logger.info({ setName: info.setName }, 'MongoDB replica set verified');
  return info.setName;
}

export function isReplicaSetVerified() {
  return replicaSetVerified;
}

export async function connectDatabase({ retries = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 20,
        minPoolSize: 2,
      });
      await assertReplicaSet();
      logger.info('MongoDB connected');
      return mongoose.connection;
    } catch (err) {
      const fatal = err.message.includes('running standalone');
      logger.error(
        { err: err.message, attempt, retries },
        fatal ? 'MongoDB topology unusable' : 'MongoDB connection failed',
      );
      if (fatal || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
  logger.info('MongoDB disconnected');
}

export default mongoose;

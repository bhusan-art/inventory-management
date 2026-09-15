import mongoose from 'mongoose';
import logger from '../config/logger.js';

/**
 * Advisory lock so a scheduled job runs once even if the worker is
 * accidentally scaled to more than one container.
 *
 * A TTL index expires abandoned locks, so a worker that crashes mid-job does
 * not block that job forever.
 */
const lockSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // job name
  owner: { type: String, required: true },
  acquiredAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

const JobLock = mongoose.model('JobLock', lockSchema);

export async function withJobLock(jobName, fn, { ttlSeconds = 900 } = {}) {
  const owner = `${process.pid}@${process.env.HOSTNAME ?? 'local'}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  try {
    await JobLock.create({ _id: jobName, owner, acquiredAt: now, expiresAt });
  } catch (err) {
    if (err.code === 11000) {
      logger.debug({ jobName }, 'Job lock held elsewhere — skipping run');
      return { skipped: true };
    }
    throw err;
  }

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await JobLock.deleteOne({ _id: jobName, owner }).catch(() => {});
  }
}

export default withJobLock;

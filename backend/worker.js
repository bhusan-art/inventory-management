/**
 * Background worker entrypoint.
 *
 * Runs on the same image as the API with a different command. Scheduled jobs
 * are registered here from Phase 8 onward (warranty alerts, low stock,
 * ledger reconciliation, integrity checks). Phase 0 ships the process, the
 * database connection and the locking primitive so that later phases only add
 * job definitions.
 */
import env from './src/config/env.js';
import logger from './src/config/logger.js';
import { connectDatabase, disconnectDatabase } from './src/config/db.js';
import { startScheduler, JOBS } from './src/jobs/scheduler.js';

async function start() {
  await connectDatabase();
  startScheduler();
  logger.info({ env: env.NODE_ENV, jobs: JOBS.length }, 'Worker started');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Worker shutting down');
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err: err.message }, 'Worker failed to start');
  process.exit(1);
});

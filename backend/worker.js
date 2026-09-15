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

const jobs = [
  // { name: 'warrantyAlerts', schedule: '0 2 * * *', handler: warrantyAlerts },
  // { name: 'lowStockScan',   schedule: '0 6 * * *', handler: lowStockScan },
  // { name: 'reconcileLedger',schedule: '0 3 * * *', handler: reconcileLedger },
];

async function start() {
  await connectDatabase();
  logger.info({ env: env.NODE_ENV, jobs: jobs.length }, 'Worker started');

  if (jobs.length === 0) {
    logger.info('No jobs registered yet — worker idle (expected until Phase 8)');
  }

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

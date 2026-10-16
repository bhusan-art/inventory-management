import cron from 'node-cron';
import logger from '../config/logger.js';
import { withJobLock } from './mongoLock.js';
import { runReconciliation } from './reconciliation.js';
import { runLowStockScan } from './lowStock.js';
import { runWarrantyAlerts, runSlaBreachScan } from './warrantyAlerts.js';

/**
 * Scheduled jobs.
 *
 * Every job runs under an advisory lock, so accidentally scaling the worker to
 * two containers does not send two sets of alerts. The lock has a TTL, so a
 * worker that crashes mid-job does not block that job forever.
 */
export const JOBS = [
  {
    name: 'reconcileInventory',
    schedule: '0 3 * * *',
    description: 'Compare inventory against the ledger and report drift',
    handler: runReconciliation,
  },
  {
    name: 'warrantyAlerts',
    schedule: '0 2 * * *',
    description: 'Alert on warranties expiring at 30, 15, 7 and 0 days',
    handler: runWarrantyAlerts,
  },
  {
    name: 'slaBreachScan',
    schedule: '0 */4 * * *',
    description: 'Flag open service tickets past their SLA',
    handler: runSlaBreachScan,
  },
  {
    name: 'lowStockScan',
    schedule: '0 6 * * *',
    description: 'Raise low-stock and out-of-stock alerts',
    handler: runLowStockScan,
  },
];

export function startScheduler({ timezone = 'Asia/Kolkata' } = {}) {
  const tasks = [];

  for (const job of JOBS) {
    const task = cron.schedule(job.schedule, async () => {
      const started = Date.now();
      try {
        const result = await withJobLock(job.name, job.handler);
        if (result.skipped) return;
        logger.info({ job: job.name, ms: Date.now() - started }, 'Job complete');
      } catch (err) {
        // A failing job must not take the worker process down with it — the
        // other jobs still need to run tonight.
        logger.error({ err, job: job.name }, 'Job failed');
      }
    }, { timezone });

    tasks.push({ job, task });
    logger.info({ job: job.name, schedule: job.schedule, timezone }, 'Job scheduled');
  }

  return tasks;
}

export default startScheduler;

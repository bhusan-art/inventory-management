import { Company } from '../models/Company.js';
import { reconcile } from '../services/inventory/ledgerService.js';
import { notify } from '../services/shared/notificationService.js';
import { writeAudit } from '../services/shared/auditService.js';
import logger from '../config/logger.js';

/**
 * Nightly reconciliation — the ledger's watchdog.
 *
 * Recomputes each location's total from the ledger and compares it to the
 * `Inventory` projection. If they disagree, something wrote stock outside
 * `ledgerService`, which should be impossible.
 *
 * It REPORTS drift; it does not fix it. Auto-correcting would make the symptom
 * disappear every night while the cause kept writing bad data, and you would
 * never know. A quiet system that is wrong is worse than a noisy one that is
 * right.
 */
export async function runReconciliation() {
  const companies = await Company.find({ status: 'ACTIVE' }).select('_id name').lean();
  const results = [];

  for (const company of companies) {
    const result = await reconcile(company._id, {});

    if (result.drift.length > 0) {
      logger.error(
        { tenant: String(company._id), drift: result.drift.slice(0, 10), total: result.drift.length },
        'INVENTORY DRIFT DETECTED',
      );

      await notify({
        tenantId: company._id,
        type: 'INVENTORY_DRIFT',
        title: `Inventory drift detected at ${result.drift.length} location${result.drift.length === 1 ? '' : 's'}`,
        body: 'Stock quantities disagree with the ledger. This indicates stock was changed '
          + 'outside the normal path and needs investigation before it is corrected.',
        severity: 'CRITICAL',
        recipientPermission: 'RECONCILE_INVENTORY',
        module: 'Inventory',
        actionUrl: '/inventory',
        // One alert per day per tenant — drift that persists should not
        // generate a new row every run.
        dedupeKey: `INVENTORY_DRIFT:${company._id}:${new Date().toISOString().slice(0, 10)}`,
      });

      await writeAudit({
        action: 'INVENTORY_DRIFT_DETECTED',
        module: 'Inventory',
        severity: 'CRITICAL',
        tenantId: company._id,
        metadata: { locations: result.drift.length, sample: result.drift.slice(0, 20) },
      });
    } else {
      logger.info({ tenant: String(company._id), checked: result.checked }, 'Reconciliation clean');
    }

    results.push({ company: String(company._id), ...result });
  }

  return results;
}

export default runReconciliation;

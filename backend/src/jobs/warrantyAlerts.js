import { Company } from '../models/Company.js';
import { Warranty } from '../models/Warranty.js';
import { ServiceRequest } from '../models/ServiceRequest.js';
import { notify } from '../services/shared/notificationService.js';
import { getSetting } from '../models/Setting.js';
import logger from '../config/logger.js';

/**
 * Warranty expiry alerts.
 *
 * Runs over `endDate`, which is indexed, and writes nothing back to the
 * warranty records — status stays derived (ARCHITECTURE.md §0.2). The job's
 * only output is notifications.
 *
 * Each threshold gets its own dedupe key, so a warranty raises an alert at 30,
 * 15, 7 and 0 days and not once a day for a month.
 */
export async function runWarrantyAlerts() {
  const companies = await Company.find({ status: 'ACTIVE' }).select('_id').lean();
  let raised = 0;

  for (const company of companies) {
    const thresholds = await getSetting(company._id, 'warranty.alertDays') ?? [30, 15, 7, 0];

    for (const days of [...thresholds].sort((a, b) => b - a)) {
      const target = startOfDay(addDays(new Date(), days));
      const nextDay = addDays(target, 1);

      const expiring = await Warranty.find({
        tenantId: company._id,
        state: 'ACTIVE',
        deletedAt: null,
        endDate: { $gte: target, $lt: nextDay },
      })
        .populate('product', 'name sku')
        .populate('customer', 'customerName')
        .populate('serialNumber', 'serialNumber')
        .limit(500);

      for (const warranty of expiring) {
        const created = await notify({
          tenantId: company._id,
          type: days === 0 ? 'WARRANTY_EXPIRING_TODAY' : 'WARRANTY_EXPIRING',
          title: days === 0
            ? `Warranty expires today: ${warranty.product?.name ?? 'unit'}`
            : `Warranty expires in ${days} days: ${warranty.product?.name ?? 'unit'}`,
          body: `${warranty.customer?.customerName ?? 'Customer'}`
            + `${warranty.serialNumber ? ` — ${warranty.serialNumber.serialNumber}` : ''}`
            + ` · ends ${warranty.endDate.toISOString().slice(0, 10)}`,
          severity: days <= 7 ? 'WARNING' : 'NOTICE',
          recipientPermission: 'VIEW_WARRANTY',
          module: 'Warranty',
          recordId: warranty._id,
          actionUrl: '/warranties',
          // One alert per warranty per threshold, for all time.
          dedupeKey: `WARRANTY_EXPIRING:${warranty._id}:${days}`,
        });
        if (created) raised += 1;
      }
    }
  }

  logger.info({ raised }, 'Warranty alert scan complete');
  return { raised };
}

/**
 * SLA breach alerts for open service tickets.
 *
 * Re-raised daily rather than once: a breached ticket that nobody has picked up
 * should keep being visible, unlike an expiry date which is a single event.
 */
export async function runSlaBreachScan() {
  const companies = await Company.find({ status: 'ACTIVE' }).select('_id').lean();
  const today = new Date().toISOString().slice(0, 10);
  let raised = 0;

  for (const company of companies) {
    const breached = await ServiceRequest.find({
      tenantId: company._id,
      deletedAt: null,
      status: { $nin: ['CLOSED', 'REJECTED', 'REPAIRED', 'REPLACED'] },
      slaDueDate: { $lt: new Date() },
    })
      .populate('customer', 'customerName')
      .populate('product', 'name')
      .limit(200);

    for (const ticket of breached) {
      const created = await notify({
        tenantId: company._id,
        type: 'SERVICE_SLA_BREACHED',
        title: `SLA breached: ${ticket.ticketNumber} (${ticket.priority})`,
        body: `${ticket.customer?.customerName ?? ''} — ${ticket.product?.name ?? ''}`
          + ` · due ${ticket.slaDueDate.toISOString().slice(0, 16).replace('T', ' ')}`,
        severity: 'WARNING',
        recipientPermission: 'ASSIGN_SERVICE_REQUEST',
        module: 'ServiceRequest',
        recordId: ticket._id,
        actionUrl: '/service-requests',
        dedupeKey: `SLA_BREACH:${ticket._id}:${today}`,
      });
      if (created) raised += 1;
    }
  }

  logger.info({ raised }, 'SLA breach scan complete');
  return { raised };
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

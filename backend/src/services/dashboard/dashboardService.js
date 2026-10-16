import { Inventory } from '../../models/Inventory.js';
import { Product } from '../../models/Product.js';
import { PurchaseOrder } from '../../models/PurchaseOrder.js';
import { GRN } from '../../models/GRN.js';
import { SalesOrder } from '../../models/SalesOrder.js';
import { WarehouseTransfer } from '../../models/WarehouseTransfer.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { Warranty } from '../../models/Warranty.js';
import { ServiceRequest } from '../../models/ServiceRequest.js';
import { CustomerReturn } from '../../models/CustomerReturn.js';
import { InventoryTransaction } from '../../models/InventoryTransaction.js';
import { EXPIRING_SOON_DAYS } from '../../utils/dates.js';
import { toObjectId } from '../../utils/objectId.js';

/**
 * The dashboard.
 *
 * Two rules shape this file.
 *
 * ONE: every panel is gated by the permission for its module. A dashboard that
 * shows a Sales Dispatch user "14 purchase orders awaiting approval" has leaked
 * the existence and volume of purchasing activity to someone with no
 * VIEW_PURCHASE_ORDER permission. A count is data. The panels an actor cannot
 * see are absent from the response, not zeroed — zero is itself an answer.
 *
 * TWO: nothing here is stored or cached. Every number is computed from the same
 * records the detail screens read, so the dashboard can never disagree with the
 * page you reach by clicking it. A nightly job writing dashboard totals would
 * be faster and would eventually be wrong, and a wrong dashboard is worse than
 * a slow one because people stop trusting the whole system.
 */

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Stock health: what is out, what is low, what is held where it cannot be sold. */
async function stockPanel(tenantId) {
  // Cast: an aggregation $match does not get Mongoose's schema casting, so a
  // string tenantId would match nothing and report an empty warehouse.
  const tenant = toObjectId(tenantId);

  const [buckets] = await Inventory.aggregate([
    { $match: { tenantId: tenant } },
    {
      $group: {
        _id: null,
        available: { $sum: '$availableQuantity' },
        reserved: { $sum: '$reservedQuantity' },
        damaged: { $sum: '$damagedQuantity' },
        inTransit: { $sum: '$inTransitQuantity' },
        underService: { $sum: '$underServiceQuantity' },
        skusStocked: { $sum: 1 },
      },
    },
  ]);

  // Low stock needs the product's own reorder level, so it joins rather than
  // comparing against a constant.
  const lowStock = await Inventory.aggregate([
    { $match: { tenantId: tenant } },
    {
      $lookup: {
        from: Product.collection.name,
        localField: 'product',
        foreignField: '_id',
        as: 'productDoc',
      },
    },
    { $unwind: '$productDoc' },
    { $match: { 'productDoc.deletedAt': null, 'productDoc.reorderLevel': { $gt: 0 } } },
    {
      $project: {
        available: '$availableQuantity',
        reorderLevel: '$productDoc.reorderLevel',
        below: { $lt: ['$availableQuantity', '$productDoc.reorderLevel'] },
        out: { $lte: ['$availableQuantity', 0] },
      },
    },
    {
      $group: {
        _id: null,
        low: { $sum: { $cond: ['$below', 1, 0] } },
        out: { $sum: { $cond: ['$out', 1, 0] } },
      },
    },
  ]);

  return {
    buckets: {
      available: buckets?.available ?? 0,
      reserved: buckets?.reserved ?? 0,
      damaged: buckets?.damaged ?? 0,
      inTransit: buckets?.inTransit ?? 0,
      underService: buckets?.underService ?? 0,
    },
    // Stated explicitly because the distinction trips people up: reserved and
    // damaged stock is REAL and counted, it just cannot be sold today.
    totalUnits: (buckets?.available ?? 0) + (buckets?.reserved ?? 0) + (buckets?.damaged ?? 0)
      + (buckets?.inTransit ?? 0) + (buckets?.underService ?? 0),
    sellableUnits: buckets?.available ?? 0,
    skusStocked: buckets?.skusStocked ?? 0,
    lowStockSkus: lowStock[0]?.low ?? 0,
    outOfStockSkus: lowStock[0]?.out ?? 0,
  };
}

async function purchasingPanel(tenantId) {
  const [awaitingApproval, openOrders, grnDrafts] = await Promise.all([
    PurchaseOrder.countDocuments({ tenantId, status: 'PENDING_APPROVAL', deletedAt: null }),
    PurchaseOrder.countDocuments({
      tenantId, status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED'] }, deletedAt: null,
    }),
    GRN.countDocuments({ tenantId, status: 'DRAFT', deletedAt: null }),
  ]);

  return { awaitingApproval, openOrders, grnDrafts };
}

async function salesPanel(tenantId) {
  const [toConfirm, awaitingDispatch] = await Promise.all([
    SalesOrder.countDocuments({ tenantId, status: 'DRAFT', deletedAt: null }),
    SalesOrder.countDocuments({
      tenantId, status: { $in: ['CONFIRMED', 'PARTIALLY_DISPATCHED'] }, deletedAt: null,
    }),
  ]);

  return { toConfirm, awaitingDispatch };
}

async function transferPanel(tenantId) {
  const [awaitingApproval, inTransit] = await Promise.all([
    WarehouseTransfer.countDocuments({ tenantId, status: 'PENDING_APPROVAL', deletedAt: null }),
    WarehouseTransfer.countDocuments({ tenantId, status: 'IN_TRANSIT', deletedAt: null }),
  ]);

  // In-transit stock is the line item most worth watching: it is ours, it is
  // on a lorry, and nobody is looking at it.
  return { awaitingApproval, inTransit };
}

async function servicePanel(tenantId) {
  const now = new Date();

  const [open, breached, awaitingReturn, expiringSoon, expired] = await Promise.all([
    ServiceRequest.countDocuments({
      tenantId, status: { $nin: ['CLOSED', 'REJECTED'] }, deletedAt: null,
    }),
    ServiceRequest.countDocuments({
      tenantId, deletedAt: null,
      status: { $nin: ['CLOSED', 'REJECTED', 'REPAIRED', 'REPLACED'] },
      slaDueDate: { $lt: now },
    }),
    // Units physically with us for service — stock we hold but do not own.
    ServiceRequest.countDocuments({
      tenantId, deletedAt: null, receivedAt: { $ne: null }, returnedAt: null,
    }),
    Warranty.countDocuments({
      tenantId, state: 'ACTIVE', deletedAt: null,
      endDate: { $gte: startOfDay(now), $lte: endOfDay(addDays(now, EXPIRING_SOON_DAYS)) },
    }),
    Warranty.countDocuments({
      tenantId, state: 'ACTIVE', deletedAt: null, endDate: { $lt: startOfDay(now) },
    }),
  ]);

  return { openTickets: open, slaBreached: breached, unitsHeld: awaitingReturn, warrantiesExpiringSoon: expiringSoon, warrantiesExpired: expired };
}

async function returnsPanel(tenantId) {
  const [awaitingApproval, awaitingGoods, awaitingInspection] = await Promise.all([
    CustomerReturn.countDocuments({ tenantId, status: 'PENDING_APPROVAL', deletedAt: null }),
    CustomerReturn.countDocuments({ tenantId, status: 'APPROVED', deletedAt: null }),
    CustomerReturn.countDocuments({ tenantId, status: 'RECEIVED', deletedAt: null }),
  ]);

  return { awaitingApproval, awaitingGoods, awaitingInspection };
}

async function serialPanel(tenantId) {
  const rows = await SerialNumber.aggregate([
    { $match: { tenantId: toObjectId(tenantId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return Object.fromEntries(rows.map((r) => [r._id, r.count]));
}

/** Movement over the last week, for a sense of tempo rather than a total. */
async function activityPanel(tenantId) {
  const since = addDays(new Date(), -7);

  const rows = await InventoryTransaction.aggregate([
    { $match: { tenantId: toObjectId(tenantId), createdAt: { $gte: since } } },
    { $group: { _id: '$transactionType', count: { $sum: 1 }, units: { $sum: { $abs: '$quantityChange' } } } },
    { $sort: { count: -1 } },
  ]);

  return {
    since,
    movements: rows.reduce((s, r) => s + r.count, 0),
    byType: rows.map((r) => ({ type: r._id, count: r.count, units: r.units })),
  };
}

/**
 * Builds the dashboard for one actor.
 *
 * Panels are requested in parallel but only the permitted ones are requested at
 * all — an unpermitted panel costs no query, which is the other benefit of
 * gating properly rather than filtering the result afterwards.
 */
export async function buildDashboard(actor) {
  const can = (permission) => actor.permissions.has(permission);
  const { tenantId } = actor;

  const panels = {};
  const jobs = [];

  const add = (key, permission, fn) => {
    if (!can(permission)) return;
    jobs.push(fn().then((value) => { panels[key] = value; }));
  };

  add('stock', 'VIEW_INVENTORY', () => stockPanel(tenantId));
  add('purchasing', 'VIEW_PURCHASE_ORDER', () => purchasingPanel(tenantId));
  add('sales', 'VIEW_SALES_ORDER', () => salesPanel(tenantId));
  add('transfers', 'VIEW_TRANSFER', () => transferPanel(tenantId));
  add('service', 'VIEW_SERVICE_REQUEST', () => servicePanel(tenantId));
  add('returns', 'VIEW_RETURN', () => returnsPanel(tenantId));
  add('serials', 'VIEW_SERIAL', () => serialPanel(tenantId));
  add('activity', 'VIEW_INVENTORY', () => activityPanel(tenantId));

  await Promise.all(jobs);

  return {
    generatedAt: new Date(),
    // Says plainly which panels were withheld, so the UI renders a coherent
    // page rather than guessing why a section is missing.
    panels,
    availablePanels: Object.keys(panels),
  };
}

/**
 * The attention list: things that need a person, newest pressure first.
 *
 * Separate from the counts because a number tells you there is a problem and
 * this tells you which one. Same permission gating.
 */
export async function buildAttentionList(actor) {
  const can = (permission) => actor.permissions.has(permission);
  const { tenantId } = actor;
  const now = new Date();
  const items = [];

  if (can('VIEW_SERVICE_REQUEST')) {
    const breached = await ServiceRequest.find({
      tenantId, deletedAt: null,
      status: { $nin: ['CLOSED', 'REJECTED', 'REPAIRED', 'REPLACED'] },
      slaDueDate: { $lt: now },
    })
      .select('ticketNumber priority slaDueDate customer')
      .populate('customer', 'customerName')
      .sort({ slaDueDate: 1 })
      .limit(5);

    for (const t of breached) {
      items.push({
        kind: 'SLA_BREACHED',
        severity: 'CRITICAL',
        label: `${t.ticketNumber} is past its SLA`,
        detail: `${t.priority} · ${t.customer?.customerName ?? ''}`,
        link: `/service-requests/${t._id}`,
        at: t.slaDueDate,
      });
    }
  }

  if (can('VIEW_RETURN')) {
    const waiting = await CustomerReturn.find({ tenantId, status: 'RECEIVED', deletedAt: null })
      .select('returnNumber receivedAt lines')
      .sort({ receivedAt: 1 })
      .limit(5);

    for (const r of waiting) {
      const pending = r.pendingDispositionQuantity;
      if (pending === 0) continue;
      items.push({
        kind: 'AWAITING_DISPOSITION',
        severity: 'WARNING',
        label: `${r.returnNumber} has ${pending} unit(s) in quarantine`,
        detail: 'Unsellable until inspected',
        link: `/customer-returns/${r._id}`,
        at: r.receivedAt,
      });
    }
  }

  if (can('VIEW_TRANSFER')) {
    const stale = await WarehouseTransfer.find({
      tenantId, status: 'IN_TRANSIT', deletedAt: null,
      dispatchedAt: { $lt: addDays(now, -7) },
    })
      .select('transferNumber dispatchedAt sourceWarehouse destinationWarehouse')
      .populate('sourceWarehouse destinationWarehouse', 'code')
      .sort({ dispatchedAt: 1 })
      .limit(5);

    for (const t of stale) {
      items.push({
        kind: 'TRANSFER_STUCK',
        severity: 'WARNING',
        label: `${t.transferNumber} has been in transit over a week`,
        detail: `${t.sourceWarehouse?.code ?? '?'} → ${t.destinationWarehouse?.code ?? '?'}`,
        link: '/transfers',
        at: t.dispatchedAt,
      });
    }
  }

  if (can('VIEW_PURCHASE_ORDER')) {
    const pending = await PurchaseOrder.find({
      tenantId, status: 'PENDING_APPROVAL', deletedAt: null,
    })
      .select('poNumber createdAt vendor')
      .populate('vendor', 'vendorName')
      .sort({ createdAt: 1 })
      .limit(5);

    for (const po of pending) {
      items.push({
        kind: 'PO_AWAITING_APPROVAL',
        severity: 'NOTICE',
        label: `${po.poNumber} is waiting for approval`,
        detail: po.vendor?.vendorName ?? '',
        link: '/purchase-orders',
        at: po.createdAt,
      });
    }
  }

  const rank = { CRITICAL: 0, WARNING: 1, NOTICE: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || new Date(a.at) - new Date(b.at));

  return items;
}

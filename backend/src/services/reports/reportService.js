import { Inventory } from '../../models/Inventory.js';
import { InventoryTransaction } from '../../models/InventoryTransaction.js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { Warranty } from '../../models/Warranty.js';
import { ServiceRequest } from '../../models/ServiceRequest.js';
import { GRN } from '../../models/GRN.js';
import { Customer } from '../../models/Customer.js';
import { toObjectId } from '../../utils/objectId.js';
import { warrantyStatus, daysRemaining, daysBetween } from '../../utils/dates.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';

/**
 * Reports.
 *
 * Every one is DERIVED at read time from the same records the detail screens
 * use. None is stored, cached or precomputed, for the reason given in
 * ARCHITECTURE.md §0.2 and restated by the dashboard: a report that disagrees
 * with the screen behind it destroys confidence in both.
 *
 * Each report declares its own columns, including which permission each column
 * needs. The export builder reads that declaration — so a report and its export
 * cannot disagree about what is visible, because they are the same list.
 */

const COLUMN = {
  // Reused across reports so a restricted column is declared once.
  customerName: { key: 'customerName', header: 'Customer' },
  customerPhone: {
    key: 'customerPhone', header: 'Customer phone',
    model: 'Customer', field: 'phone',
  },
  customerEmail: {
    key: 'customerEmail', header: 'Customer email',
    model: 'Customer', field: 'email',
  },
  vendorPhone: {
    key: 'vendorPhone', header: 'Vendor phone',
    model: 'Vendor', field: 'phone',
  },
};

/**
 * STOCK ON HAND — what is where, split by bucket.
 *
 * The buckets are the point. A single "quantity" column would hide that a
 * warehouse with 400 units may have nothing it can actually ship.
 */
const stockOnHand = {
  name: 'Stock on hand',
  permission: 'VIEW_INVENTORY',
  columns: [
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    { key: 'warehouse', header: 'Warehouse' },
    { key: 'available', header: 'Available', type: 'number' },
    { key: 'reserved', header: 'Reserved', type: 'number' },
    { key: 'damaged', header: 'Damaged', type: 'number' },
    { key: 'inTransit', header: 'In transit', type: 'number' },
    { key: 'underService', header: 'Under service', type: 'number' },
    { key: 'total', header: 'Total', type: 'number' },
    { key: 'reorderLevel', header: 'Reorder level', type: 'number' },
    { key: 'belowReorder', header: 'Below reorder' },
  ],
  async rows(actor, query) {
    const match = { tenantId: toObjectId(actor.tenantId) };
    if (query.warehouse) match.warehouse = toObjectId(query.warehouse);
    if (query.product) match.product = toObjectId(query.product);

    const pipeline = [
      { $match: match },
      { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      { $match: { 'p.deletedAt': null } },
      { $lookup: { from: 'warehouses', localField: 'warehouse', foreignField: '_id', as: 'w' } },
      { $unwind: '$w' },
      {
        $project: {
          sku: '$p.sku',
          product: '$p.name',
          warehouse: '$w.name',
          available: '$availableQuantity',
          reserved: '$reservedQuantity',
          damaged: '$damagedQuantity',
          inTransit: '$inTransitQuantity',
          underService: '$underServiceQuantity',
          total: {
            $add: ['$availableQuantity', '$reservedQuantity', '$damagedQuantity',
              '$inTransitQuantity', '$underServiceQuantity'],
          },
          reorderLevel: '$p.reorderLevel',
          belowReorder: {
            $cond: [{ $lt: ['$availableQuantity', '$p.reorderLevel'] }, 'YES', ''],
          },
        },
      },
      { $sort: { sku: 1, warehouse: 1 } },
    ];

    if (query.belowReorderOnly) pipeline.push({ $match: { belowReorder: 'YES' } });

    return Inventory.aggregate(pipeline);
  },
};

/**
 * STOCK AGEING — how long each serialized unit has sat.
 *
 * Only serialized stock can answer this honestly. Bulk quantities have no
 * identity, so "how old is this cable" has no answer; pretending otherwise by
 * averaging receipt dates would invent a number. The report says what it can
 * and leaves the rest alone.
 */
const stockAgeing = {
  name: 'Stock ageing',
  permission: 'VIEW_SERIAL',
  columns: [
    { key: 'serialNumber', header: 'Serial' },
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    { key: 'warehouse', header: 'Warehouse' },
    { key: 'status', header: 'Status' },
    { key: 'receivedDate', header: 'Received', type: 'date' },
    { key: 'ageDays', header: 'Age (days)', type: 'number' },
    { key: 'ageBand', header: 'Age band' },
  ],
  async rows(actor, query) {
    const filter = {
      tenantId: actor.tenantId,
      status: { $in: ['AVAILABLE', 'RECEIVED', 'DAMAGED'] },
    };
    if (query.warehouse) filter.warehouse = query.warehouse;

    const serials = await SerialNumber.find(filter)
      .populate('product', 'name sku')
      .populate('warehouse', 'name')
      .sort({ receivedDate: 1 })
      .lean();

    const now = new Date();

    return serials.map((s) => {
      const age = s.receivedDate ? daysBetween(new Date(s.receivedDate), now) : null;
      return {
        serialNumber: s.serialNumber,
        sku: s.product?.sku ?? '',
        product: s.product?.name ?? '',
        warehouse: s.warehouse?.name ?? '',
        status: s.status,
        receivedDate: s.receivedDate ?? null,
        ageDays: age,
        ageBand: band(age),
      };
    });
  },
};

function band(days) {
  if (days === null) return 'Unknown';
  if (days <= 30) return '0–30';
  if (days <= 90) return '31–90';
  if (days <= 180) return '91–180';
  if (days <= 365) return '181–365';
  return 'Over a year';
}

/** LEDGER — every movement, filtered. The audit trail in report form. */
const stockMovement = {
  name: 'Stock movement',
  permission: 'VIEW_INVENTORY',
  columns: [
    { key: 'createdAt', header: 'When', type: 'date' },
    { key: 'transactionNumber', header: 'Transaction' },
    { key: 'transactionType', header: 'Type' },
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    { key: 'warehouse', header: 'Warehouse' },
    { key: 'serialNumber', header: 'Serial' },
    { key: 'bucketFrom', header: 'From bucket' },
    { key: 'bucketTo', header: 'To bucket' },
    { key: 'quantityChange', header: 'Change', type: 'number' },
    { key: 'quantityAfter', header: 'Balance after', type: 'number' },
    { key: 'referenceNumber', header: 'Reference' },
    { key: 'performedBy', header: 'By' },
    { key: 'remarks', header: 'Remarks' },
  ],
  async rows(actor, query) {
    const filter = { tenantId: actor.tenantId };
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }
    if (query.warehouse) filter.warehouse = query.warehouse;
    if (query.product) filter.product = query.product;
    if (query.transactionType) filter.transactionType = query.transactionType;

    const rows = await InventoryTransaction.find(filter)
      .populate('product', 'name sku')
      .populate('warehouse', 'name')
      .populate('serialNumber', 'serialNumber')
      .populate('performedBy', 'fullName')
      .sort({ createdAt: -1 })
      .limit(50_000)
      .lean();

    return rows.map((r) => ({
      createdAt: r.createdAt,
      transactionNumber: r.transactionNumber,
      transactionType: r.transactionType,
      sku: r.product?.sku ?? '',
      product: r.product?.name ?? '',
      warehouse: r.warehouse?.name ?? '',
      serialNumber: r.serialNumber?.serialNumber ?? '',
      bucketFrom: r.bucketFrom ?? '',
      bucketTo: r.bucketTo ?? '',
      quantityChange: r.quantityChange,
      quantityAfter: r.quantityAfter,
      referenceNumber: r.referenceNumber ?? '',
      performedBy: r.performedBy?.fullName ?? '',
      remarks: r.remarks ?? '',
    }));
  },
};

/**
 * WARRANTY EXPIRY — what lapses when.
 *
 * Status is computed here exactly as it is everywhere else, by calling the
 * same `warrantyStatus`. A report that reimplemented the rule would eventually
 * disagree with the screen.
 */
const warrantyExpiry = {
  name: 'Warranty expiry',
  permission: 'VIEW_WARRANTY',
  columns: [
    { key: 'warrantyNumber', header: 'Warranty' },
    { key: 'serialNumber', header: 'Serial' },
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    COLUMN.customerName,
    COLUMN.customerPhone,
    COLUMN.customerEmail,
    { key: 'startDate', header: 'Cover from', type: 'date' },
    { key: 'endDate', header: 'Cover until', type: 'date' },
    { key: 'daysRemaining', header: 'Days left', type: 'number' },
    { key: 'status', header: 'Status' },
    { key: 'state', header: 'State' },
  ],
  async rows(actor, query) {
    const filter = { tenantId: actor.tenantId, deletedAt: null };
    if (query.state) filter.state = query.state;
    if (query.customer) filter.customer = query.customer;
    if (query.withinDays) {
      const until = new Date();
      until.setDate(until.getDate() + Number(query.withinDays));
      filter.endDate = { $lte: until };
      filter.state = filter.state ?? 'ACTIVE';
    }

    const rows = await Warranty.find(filter)
      .populate('product', 'name sku')
      .populate('customer', 'customerName phone email')
      .populate('serialNumber', 'serialNumber')
      .sort({ endDate: 1 })
      .lean();

    return rows.map((w) => ({
      warrantyNumber: w.warrantyNumber,
      serialNumber: w.serialNumber?.serialNumber ?? '',
      sku: w.product?.sku ?? '',
      product: w.product?.name ?? '',
      customerName: w.customer?.customerName ?? '',
      // Present in the row; the export builder removes the column entirely for
      // an actor without VIEW_CONTACT_DETAILS.
      customerPhone: w.customer?.phone ?? '',
      customerEmail: w.customer?.email ?? '',
      startDate: w.startDate,
      endDate: w.endDate,
      daysRemaining: daysRemaining(w),
      status: warrantyStatus(w),
      state: w.state,
    }));
  },
};

/** SERVICE SLA — how the service desk is actually performing. */
const serviceSla = {
  name: 'Service SLA',
  permission: 'VIEW_SERVICE_REQUEST',
  columns: [
    { key: 'ticketNumber', header: 'Ticket' },
    COLUMN.customerName,
    { key: 'product', header: 'Product' },
    { key: 'serialNumber', header: 'Serial' },
    { key: 'priority', header: 'Priority' },
    { key: 'status', header: 'Status' },
    { key: 'warrantyApplicable', header: 'In warranty' },
    { key: 'reportedDate', header: 'Reported', type: 'date' },
    { key: 'slaDueDate', header: 'SLA due', type: 'date' },
    { key: 'closedAt', header: 'Closed', type: 'date' },
    { key: 'resolutionHours', header: 'Resolution (hours)', type: 'number' },
    { key: 'slaMet', header: 'SLA met' },
    { key: 'assignedTo', header: 'Engineer' },
  ],
  async rows(actor, query) {
    const filter = { tenantId: actor.tenantId, deletedAt: null };
    if (query.from || query.to) {
      filter.reportedDate = {};
      if (query.from) filter.reportedDate.$gte = new Date(query.from);
      if (query.to) filter.reportedDate.$lte = new Date(query.to);
    }
    if (query.priority) filter.priority = query.priority;
    if (query.openOnly) filter.status = { $nin: ['CLOSED', 'REJECTED'] };

    const rows = await ServiceRequest.find(filter)
      .populate('customer', 'customerName')
      .populate('product', 'name')
      .populate('serialNumber', 'serialNumber')
      .populate('assignedTo', 'fullName')
      .sort({ reportedDate: -1 })
      .lean();

    const now = new Date();

    return rows.map((t) => {
      const finished = t.closedAt ?? null;
      const hours = finished
        ? Math.round(((finished - t.reportedDate) / 3_600_000) * 10) / 10
        : null;

      // An open ticket past its deadline has already missed; one still running
      // is undecided, not a pass. Calling it a pass would flatter the figure.
      const slaMet = !t.slaDueDate ? ''
        : finished ? (finished <= t.slaDueDate ? 'YES' : 'NO')
          : (now > t.slaDueDate ? 'NO' : 'OPEN');

      return {
        ticketNumber: t.ticketNumber,
        customerName: t.customer?.customerName ?? '',
        product: t.product?.name ?? '',
        serialNumber: t.serialNumber?.serialNumber ?? '',
        priority: t.priority,
        status: t.status,
        warrantyApplicable: t.warrantyApplicable ? 'YES' : 'NO',
        reportedDate: t.reportedDate,
        slaDueDate: t.slaDueDate ?? null,
        closedAt: finished,
        resolutionHours: hours,
        slaMet,
        assignedTo: t.assignedTo?.fullName ?? '',
      };
    });
  },
};

/**
 * VENDOR PERFORMANCE — quality on arrival, from posted GRNs.
 *
 * Measures only what this system actually observes: how much of what a vendor
 * sent was accepted. On-time delivery would need a promised date the purchase
 * order does not reliably carry, and inventing it from the order date would be
 * a fabricated metric that somebody would then make a decision on.
 */
const vendorPerformance = {
  name: 'Vendor performance',
  permission: 'VIEW_VENDOR',
  columns: [
    { key: 'vendorCode', header: 'Code' },
    { key: 'vendorName', header: 'Vendor' },
    COLUMN.vendorPhone,
    { key: 'receipts', header: 'Receipts', type: 'number' },
    { key: 'unitsReceived', header: 'Units received', type: 'number' },
    { key: 'unitsAccepted', header: 'Units accepted', type: 'number' },
    { key: 'unitsDamaged', header: 'Units damaged', type: 'number' },
    { key: 'unitsRejected', header: 'Units rejected', type: 'number' },
    { key: 'acceptanceRate', header: 'Acceptance %', type: 'number' },
    { key: 'lastReceipt', header: 'Last receipt', type: 'date' },
  ],
  async rows(actor, query) {
    const match = { tenantId: toObjectId(actor.tenantId), status: 'POSTED', deletedAt: null };
    if (query.from || query.to) {
      match.receivedDate = {};
      if (query.from) match.receivedDate.$gte = new Date(query.from);
      if (query.to) match.receivedDate.$lte = new Date(query.to);
    }

    const rows = await GRN.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$vendor',
          receipts: { $addToSet: '$_id' },
          unitsReceived: { $sum: '$lines.receivedQuantity' },
          unitsAccepted: { $sum: '$lines.acceptedQuantity' },
          unitsDamaged: { $sum: { $ifNull: ['$lines.damagedQuantity', 0] } },
          unitsRejected: { $sum: { $ifNull: ['$lines.rejectedQuantity', 0] } },
          lastReceipt: { $max: '$receivedDate' },
        },
      },
      { $lookup: { from: 'vendors', localField: '_id', foreignField: '_id', as: 'v' } },
      { $unwind: '$v' },
      {
        $project: {
          vendorCode: '$v.vendorCode',
          vendorName: '$v.vendorName',
          vendorPhone: '$v.phone',
          receipts: { $size: '$receipts' },
          unitsReceived: 1,
          unitsAccepted: 1,
          unitsDamaged: 1,
          unitsRejected: 1,
          acceptanceRate: {
            $cond: [
              { $gt: ['$unitsReceived', 0] },
              { $round: [{ $multiply: [{ $divide: ['$unitsAccepted', '$unitsReceived'] }, 100] }, 1] },
              null,
            ],
          },
          lastReceipt: 1,
        },
      },
      { $sort: { acceptanceRate: 1, vendorName: 1 } },
    ]);

    return rows;
  },
};

/** CUSTOMER ASSETS — what each customer currently holds from us. */
const customerAssets = {
  name: 'Customer assets',
  permission: 'VIEW_CUSTOMER',
  columns: [
    COLUMN.customerName,
    { key: 'customerCode', header: 'Code' },
    COLUMN.customerPhone,
    { key: 'serialNumber', header: 'Serial' },
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    { key: 'dispatchDate', header: 'Dispatched', type: 'date' },
    { key: 'warrantyUntil', header: 'Cover until', type: 'date' },
    { key: 'warrantyStatus', header: 'Cover status' },
    { key: 'installationLocation', header: 'Installed at' },
  ],
  async rows(actor, query) {
    const filter = { tenantId: actor.tenantId, status: 'DISPATCHED' };
    if (query.customer) filter.customer = query.customer;

    const serials = await SerialNumber.find(filter)
      .populate('customer', 'customerName customerCode phone')
      .populate('product', 'name sku')
      .populate('currentWarranty', 'endDate state')
      .sort({ dispatchDate: -1 })
      .lean();

    return serials.map((s) => ({
      customerName: s.customer?.customerName ?? '',
      customerCode: s.customer?.customerCode ?? '',
      customerPhone: s.customer?.phone ?? '',
      serialNumber: s.serialNumber,
      sku: s.product?.sku ?? '',
      product: s.product?.name ?? '',
      dispatchDate: s.dispatchDate ?? null,
      warrantyUntil: s.currentWarranty?.endDate ?? null,
      warrantyStatus: s.currentWarranty ? warrantyStatus(s.currentWarranty) : 'NONE',
      installationLocation: s.installationLocation ?? '',
    }));
  },
};

export const REPORTS = Object.freeze({
  'stock-on-hand': stockOnHand,
  'stock-ageing': stockAgeing,
  'stock-movement': stockMovement,
  'warranty-expiry': warrantyExpiry,
  'service-sla': serviceSla,
  'vendor-performance': vendorPerformance,
  'customer-assets': customerAssets,
});

export const REPORT_KEYS = Object.freeze(Object.keys(REPORTS));

/** Resolves a report and checks the actor may run it. */
export function getReport(actor, key) {
  const report = REPORTS[key];
  if (!report) throw new NotFoundError(`No such report: ${key}`, 'UNKNOWN_REPORT');

  if (!actor.permissions.has(report.permission)) {
    throw new ForbiddenError(
      `You do not have permission to run the ${report.name} report`,
      'REPORT_ACCESS_DENIED',
    );
  }
  return report;
}

/** The reports this actor may run — drives the menu, so it offers nothing refusable. */
export function availableReports(actor) {
  return REPORT_KEYS
    .filter((key) => actor.permissions.has(REPORTS[key].permission))
    .map((key) => ({
      key,
      name: REPORTS[key].name,
      permission: REPORTS[key].permission,
    }));
}

export { Customer };

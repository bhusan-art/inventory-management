import { Company } from '../models/Company.js';
import { Inventory } from '../models/Inventory.js';
import { notify } from '../services/shared/notificationService.js';
import logger from '../config/logger.js';

/**
 * Low-stock and out-of-stock alerts.
 *
 * Compares each location's available quantity against the product's reorder
 * level. Products with a reorder level of zero are skipped — a zero threshold
 * means "we do not manage this by reorder point", not "alert on everything".
 */
export async function runLowStockScan() {
  const companies = await Company.find({ status: 'ACTIVE' }).select('_id').lean();
  const today = new Date().toISOString().slice(0, 10);
  let raised = 0;

  for (const company of companies) {
    const rows = await Inventory.aggregate([
      { $match: { tenantId: company._id } },
      { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      {
        $match: {
          'product.deletedAt': null,
          'product.status': 'ACTIVE',
          'product.reorderLevel': { $gt: 0 },
          $expr: { $lte: ['$availableQuantity', '$product.reorderLevel'] },
        },
      },
      { $lookup: { from: 'warehouses', localField: 'warehouse', foreignField: '_id', as: 'warehouse' } },
      { $unwind: '$warehouse' },
      { $limit: 500 },
    ]);

    for (const row of rows) {
      const isOut = row.availableQuantity === 0;
      const created = await notify({
        tenantId: company._id,
        type: isOut ? 'OUT_OF_STOCK' : 'LOW_STOCK',
        title: isOut
          ? `Out of stock: ${row.product.name} at ${row.warehouse.name}`
          : `Low stock: ${row.product.name} at ${row.warehouse.name}`,
        body: `${row.availableQuantity} available, reorder level ${row.product.reorderLevel}`
          + (row.product.reorderQuantity ? `. Suggested order: ${row.product.reorderQuantity}.` : '.'),
        severity: isOut ? 'WARNING' : 'NOTICE',
        recipientPermission: 'CREATE_PURCHASE_ORDER',
        module: 'Inventory',
        recordId: row._id,
        actionUrl: '/inventory',
        dedupeKey: `${isOut ? 'OUT_OF_STOCK' : 'LOW_STOCK'}:${row.product._id}:${row.warehouse._id}:${today}`,
      });
      if (created) raised += 1;
    }
  }

  logger.info({ raised }, 'Low stock scan complete');
  return { raised };
}

export default runLowStockScan;

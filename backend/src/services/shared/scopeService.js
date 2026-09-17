import { NotFoundError } from '../../utils/errors.js';

/**
 * Warehouse scope enforcement.
 *
 * An empty `warehouseIds` on the user means every warehouse in the tenant; a
 * populated list restricts them to those sites.
 *
 * Out-of-scope access returns 404, not 403. A 403 confirms the record exists,
 * which is itself a disclosure — a warehouse operator at one site should not be
 * able to enumerate another site's GRN numbers by watching which ids come back
 * "forbidden" and which come back "not found".
 */
export function assertWarehouseInScope(actor, warehouseId) {
  if (actor.hasGlobalWarehouseScope) return true;
  if (!warehouseId) return true;

  if (!actor.warehouseIds.includes(String(warehouseId))) {
    throw new NotFoundError('Not found', 'WAREHOUSE_OUT_OF_SCOPE');
  }
  return true;
}

/** Mandatory query condition for list endpoints — not a caller-supplied filter. */
export function warehouseScopeFilter(actor) {
  return actor.hasGlobalWarehouseScope ? {} : { warehouse: { $in: actor.warehouseIds } };
}

export default assertWarehouseInScope;

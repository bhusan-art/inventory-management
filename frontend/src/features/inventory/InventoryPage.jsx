import { useCallback, useEffect, useState } from 'react';
import { Plus, SlidersHorizontal } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import DataTable from '../../components/table/DataTable.jsx';
import StockAdjustDialog from './StockAdjustDialog.jsx';

/**
 * Inventory, with the ability to change it.
 *
 * A dedicated screen rather than the generic list, because stock is the one
 * thing here that is not a record you create — it is a consequence of
 * documents. The only direct write is an adjustment, which is deliberately
 * the exception: everything else should arrive through a goods receipt and
 * leave through a dispatch, each with paperwork behind it.
 */

const COLUMNS = [
  { key: 'sku', label: 'SKU', mono: true, render: (r) => r.product?.code ?? r.product?.sku ?? '—' },
  { key: 'product', label: 'Product', render: (r) => r.product?.name ?? '—' },
  { key: 'warehouse', label: 'Warehouse', render: (r) => r.warehouse?.name ?? '—' },
  { key: 'available', label: 'Available' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'damaged', label: 'Damaged' },
  { key: 'total', label: 'Total' },
];

export default function InventoryPage() {
  const canAdjust = usePermission('ADJUST_INVENTORY');

  const [page, setPage] = useState(1);
  const [state, setState] = useState({ rows: [], meta: null, loading: true, error: null });
  const [adjusting, setAdjusting] = useState(null);

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get('/inventory', { params: { page, limit: 25 } })
      .then((res) => setState({ rows: res.data.data, meta: res.data.meta, loading: false, error: null }))
      .catch((err) => setState({
        rows: [], meta: null, loading: false, error: toMessage(err, 'Could not load inventory'),
      }));
  }, [page]);

  useEffect(load, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Inventory</h1>
          {state.meta && (
            <p className="text-sm text-ink-muted">
              {state.meta.total} stock record{state.meta.total === 1 ? '' : 's'}
            </p>
          )}
        </div>

        {canAdjust && (
          <button
            type="button"
            // An empty object means "open, with nothing preselected" — the
            // dialog then asks for product and warehouse, which is how stock
            // is first put against a product that has never been stocked.
            onClick={() => setAdjusting({})}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> Adjust stock
          </button>
        )}
      </div>

      {state.rows.length === 0 && !state.loading && !state.error && (
        <div className="rounded-panel border border-line bg-surface p-6 text-sm text-ink-soft">
          <p className="font-medium text-ink">No stock yet.</p>
          <p className="mt-1">
            Stock normally arrives through a <strong>purchase order</strong> and then a{' '}
            <strong>goods receipt</strong>, which records who supplied it and when. Use
            &ldquo;Adjust stock&rdquo; only for an opening balance — what is already on the shelf
            before the system existed.
          </p>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        rows={state.rows}
        meta={state.meta}
        loading={state.loading}
        error={state.error}
        onPageChange={setPage}
        emptyMessage="No stock records"
        rowActions={canAdjust ? (row) => (
          <button
            type="button"
            onClick={() => setAdjusting(row)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-soft hover:bg-paper hover:text-ink"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Adjust
          </button>
        ) : undefined}
      />

      {adjusting && (
        <StockAdjustDialog
          row={adjusting.product ? adjusting : null}
          onClose={() => setAdjusting(null)}
          onDone={() => { setAdjusting(null); load(); }}
        />
      )}
    </div>
  );
}

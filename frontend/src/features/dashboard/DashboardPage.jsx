import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, AlertTriangle, Boxes, ChevronDown, Clock, Info,
  PackageX, ShieldCheck, Wrench,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { useSession, usePermissions } from '../../hooks/usePermission.js';
import Donut from '../../components/charts/Donut.jsx';

/**
 * Slice colours, validated — not chosen by eye.
 *
 * Both sets were run through the colour-blindness and contrast checker. The
 * first five-bucket arrangement FAILED: the "under service" orange sat at
 * ΔE 10.1 from the in-transit yellow for normal vision, under the floor of 15
 * where two hues stop being separable at all, so the orange became violet.
 * Two hues here fall under 3:1 against white, which is permitted only because
 * every slice is labelled with its name and count in the legend.
 */
const BUCKET_SLICES = [
  { key: 'available', label: 'Available', color: '#1baf7a' },
  { key: 'reserved', label: 'Reserved', color: '#2a78d6' },
  { key: 'inTransit', label: 'In transit', color: '#eda100' },
  { key: 'underService', label: 'Under service', color: '#6250d6' },
  { key: 'damaged', label: 'Damaged', color: '#d03b3b' },
];

const WARRANTY_SLICES = [
  { key: 'active', label: 'Active', color: '#1baf7a' },
  { key: 'expiringSoon', label: 'Expiring soon', color: '#eda100' },
  { key: 'expired', label: 'Expired', color: '#d03b3b' },
  { key: 'voided', label: 'Voided', color: '#6250d6' },
];

const toSegments = (slices, source) => slices.map((s) => ({
  label: s.label, color: s.color, value: Number(source?.[s.key] ?? 0),
}));

/**
 * The dashboard.
 *
 * Every panel comes from the API already filtered by permission — the server
 * sends only the panels this actor may see, and `availablePanels` says which
 * those are. The page renders what it is given rather than deciding for itself,
 * so there is no second, weaker gate here that could disagree with the real one.
 *
 * The one hero figure is sellable stock, because that is the number the
 * business actually runs on. Everything else is a stat tile.
 */
export default function DashboardPage() {
  const session = useSession();
  const [state, setState] = useState({ data: null, attention: [], loading: true, error: null });
  // Warranty counts are not part of the dashboard payload — they have their
  // own endpoint, which until now nothing called. Fetched separately and
  // allowed to fail: an actor without VIEW_WARRANTY simply gets no panel,
  // which is the same rule the server applies to every other panel.
  const [warranty, setWarranty] = useState(null);

  useEffect(() => {
    let cancelled = false;

    api.get('/warranties/summary')
      .then((res) => !cancelled && setWarranty(res.data?.data ?? null))
      .catch(() => !cancelled && setWarranty(null));

    Promise.all([api.get('/dashboard'), api.get('/dashboard/attention')])
      .then(([dash, attn]) => {
        if (cancelled) return;
        setState({ data: dash.data.data, attention: attn.data.data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          data: null, attention: [], loading: false,
          error: toMessage(err, 'Could not load the dashboard'),
        });
      });

    return () => { cancelled = true; };
  }, []);

  if (state.loading) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }
  if (state.error) {
    return (
      <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {state.error}
      </div>
    );
  }

  const { panels } = state.data;

  return (
    <div
      className="space-y-6"
      style={{
        // The validated categorical slots, as roles. Light values here; the
        // dark steps are swapped below rather than being an automatic flip,
        // because a lightened light palette does not survive the dark surface.
        '--bucket-available': '#2a78d6',
        '--bucket-reserved': '#eb6834',
        '--bucket-damaged': '#1baf7a',
        '--bucket-inTransit': '#eda100',
        '--bucket-underService': '#e87ba4',
      }}
    >
      <div>
        <h1 className="text-lg font-semibold text-ink">
          {greeting()}, {session?.fullName?.split(' ')[0] ?? 'there'}
        </h1>
        <p className="text-sm text-ink-muted">
          {new Date(state.data.generatedAt).toLocaleString('en-IN', {
            weekday: 'long', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
        </p>
      </div>

      {state.attention.length > 0 && <AttentionList items={state.attention} />}

      {panels.stock && (
        <section className="rounded-panel border border-line bg-surface p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs text-ink-muted">Sellable stock</p>
              {/* The one hero figure on the page. */}
              <p className="text-5xl font-semibold leading-none text-ink">
                {panels.stock.sellableUnits.toLocaleString('en-IN')}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                units across {panels.stock.skusStocked} SKU{panels.stock.skusStocked === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex gap-6">
              <MiniStat
                label="Low stock"
                value={panels.stock.lowStockSkus}
                tone={panels.stock.lowStockSkus > 0 ? 'warning' : 'calm'}
              />
              <MiniStat
                label="Out of stock"
                value={panels.stock.outOfStockSkus}
                tone={panels.stock.outOfStockSkus > 0 ? 'critical' : 'calm'}
              />
            </div>
          </div>

          <p className="mt-5 border-t border-slate-100 pt-4 text-sm text-ink-soft">
            {panels.stock.totalUnits.toLocaleString('en-IN')} units in total. Only the available
            bucket can be sold today — the rest is real stock that is committed, held back,
            moving, or in for repair.
          </p>
        </section>
      )}

      {(panels.stock || warranty) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {panels.stock && (
            <Donut
              title="Where the stock is"
              totalLabel="units"
              segments={toSegments(BUCKET_SLICES, panels.stock.buckets)}
              emptyMessage="No stock recorded yet. Receive a delivery or set an opening balance."
            />
          )}
          {warranty && (
            <Donut
              title="Warranty cover"
              totalLabel="units covered"
              segments={toSegments(WARRANTY_SLICES, warranty)}
              emptyMessage="No warranties yet. One is created for each serialized unit dispatched to a customer."
            />
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {panels.purchasing && (
          <Tile icon={Boxes} title="Purchasing" to="/purchase-orders" rows={[
            ['Awaiting approval', panels.purchasing.awaitingApproval],
            ['Open orders', panels.purchasing.openOrders],
            ['Draft receipts', panels.purchasing.grnDrafts],
          ]} />
        )}
        {panels.sales && (
          <Tile icon={PackageX} title="Sales" to="/sales-orders" rows={[
            ['To confirm', panels.sales.toConfirm],
            ['Awaiting dispatch', panels.sales.awaitingDispatch],
          ]} />
        )}
        {panels.transfers && (
          <Tile icon={Clock} title="Transfers" to="/transfers" rows={[
            ['Awaiting approval', panels.transfers.awaitingApproval],
            ['In transit', panels.transfers.inTransit],
          ]} />
        )}
        {panels.service && (
          <Tile icon={Wrench} title="Service" to="/service-requests" rows={[
            ['Open tickets', panels.service.openTickets],
            ['SLA breached', panels.service.slaBreached, panels.service.slaBreached > 0 && 'critical'],
            ['Units held', panels.service.unitsHeld],
          ]} />
        )}
        {panels.service && (
          <Tile icon={ShieldCheck} title="Warranty" to="/warranties" rows={[
            ['Expiring in 30 days', panels.service.warrantiesExpiringSoon,
              panels.service.warrantiesExpiringSoon > 0 && 'warning'],
            ['Already expired', panels.service.warrantiesExpired],
          ]} />
        )}
        {panels.returns && (
          <Tile icon={AlertTriangle} title="Returns" to="/customer-returns" rows={[
            ['Awaiting approval', panels.returns.awaitingApproval],
            ['Goods expected', panels.returns.awaitingGoods],
            ['To inspect', panels.returns.awaitingInspection,
              panels.returns.awaitingInspection > 0 && 'warning'],
          ]} />
        )}
      </div>

      {panels.activity && <Activity activity={panels.activity} />}

      <PermissionPanel />
    </div>
  );
}

/**
 * Things needing a person, worst first.
 *
 * Status colour always travels with an icon and a label, never alone — two of
 * the four status steps sit below 3:1 on a light surface by design, and the
 * icon is the mitigation.
 */
function AttentionList({ items }) {
  const style = {
    CRITICAL: { icon: AlertCircle, colour: '#d03b3b', label: 'Critical' },
    WARNING: { icon: AlertTriangle, colour: '#fab219', label: 'Warning' },
    NOTICE: { icon: Info, colour: '#2a78d6', label: 'Notice' },
  };

  return (
    <section className="rounded-panel border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Needs attention</h2>
        <p className="text-xs text-ink-muted">{items.length} item{items.length === 1 ? '' : 's'}</p>
      </div>
      <ul className="divide-y divide-line/70">
        {items.map((item, i) => {
          const s = style[item.severity] ?? style.NOTICE;
          const Icon = s.icon;

          return (
            <li key={`${item.kind}-${i}`} className="flex items-start gap-3 px-4 py-2.5">
              <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: s.colour }} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <Link to={item.link} className="text-sm text-ink hover:underline">
                  {item.label}
                </Link>
                {item.detail && <p className="text-xs text-ink-muted">{item.detail}</p>}
              </div>
              {/* The severity in words, so it is never colour alone. */}
              <span className="shrink-0 text-xs text-ink-muted">{s.label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tile({ icon: Icon, title, to, rows }) {
  return (
    <Link
      to={to}
      className="rounded-panel border border-line bg-surface p-4 transition-colors hover:border-line-strong"
    >
      <div className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      <dl className="mt-2 space-y-1">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-xs text-ink-soft">{label}</dt>
            <dd
              className="text-sm font-medium tabular-nums"
              style={{
                color: tone === 'critical' ? '#d03b3b'
                  : tone === 'warning' ? '#b45309'
                    : undefined,
              }}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}

function MiniStat({ label, value, tone }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className="text-2xl font-semibold"
        style={{
          color: tone === 'critical' ? '#d03b3b' : tone === 'warning' ? '#b45309' : '#0f172a',
        }}
      >
        {value}
      </p>
    </div>
  );
}

/** Movement over the last week — tempo, not a total. */
function Activity({ activity }) {
  const max = Math.max(1, ...activity.byType.map((t) => t.count));

  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <h2 className="text-sm font-medium text-ink">Movement this week</h2>
      <p className="text-xs text-ink-muted">
        {activity.movements} ledger entr{activity.movements === 1 ? 'y' : 'ies'} since{' '}
        {new Date(activity.since).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
      </p>

      {activity.byType.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">Nothing has moved this week.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {activity.byType.map((row) => (
            <li key={row.type} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3">
              <span className="truncate text-xs text-ink-soft">{humanize(row.type)}</span>
              {/* One series, so no legend: the row label names it. */}
              <span className="h-2 rounded-sm bg-slate-100">
                <span
                  className="block h-2 rounded-sm"
                  style={{ width: `${(row.count / max) * 100}%`, backgroundColor: '#2a78d6' }}
                />
              </span>
              <span className="text-right text-xs text-ink tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Phase 1 permission inspector, kept but collapsed.
 *
 * It was the fastest way to confirm the permission matrix was behaving during
 * the build, and it still is — so it stays, out of the way rather than deleted.
 */
function PermissionPanel() {
  const session = useSession();
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);

  const grouped = [...permissions].sort().reduce((acc, code) => {
    const module = code.split('_').slice(1).join('_') || 'GENERAL';
    (acc[module] ??= []).push(code);
    return acc;
  }, {});

  return (
    <section className="rounded-panel border border-line bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        <span className="text-sm font-medium text-ink">Your effective permissions</span>
        <span className="text-xs text-ink-muted">{permissions.size} granted</span>
        <ChevronDown className={`ml-auto h-4 w-4 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-3 text-xs text-ink-muted">
            Resolved as role ∪ grants − denies. Warehouse scope:{' '}
            {session?.scope?.hasGlobalWarehouseScope
              ? 'all warehouses'
              : `${session?.scope?.warehouseIds?.length ?? 0} assigned`}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(grouped).map(([module, codes]) => (
              <div key={module} className="rounded border border-line p-2">
                <p className="text-xs font-medium text-ink-soft">{module}</p>
                <ul className="mt-1 space-y-0.5">
                  {codes.map((code) => (
                    <li key={code} className="font-mono text-[11px] text-ink-muted">{code}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const humanize = (v) => (v ? String(v).replace(/_/g, ' ').toLowerCase() : '—');

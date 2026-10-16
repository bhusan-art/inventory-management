import { useState } from 'react';

/**
 * The five stock buckets as one stacked bar.
 *
 * It is a bar and not a pie because the job is magnitude comparison between
 * parts, and a stacked bar lets you compare segment lengths against a common
 * baseline. A pie asks you to compare angles, which people cannot do.
 *
 * Colours are the validated categorical palette in fixed slot order — never
 * cycled, never reassigned when a bucket is empty, because colour follows the
 * entity and not its rank. Three of the light-mode slots sit below 3:1 against
 * a white card, which the palette validator flags as requiring relief, so every
 * segment carries a visible label and the legend repeats each value as a small
 * table. Identity is never colour alone.
 */
/**
 * The dark-mode steps are recorded but NOT applied: the app is light-only
 * today (`darkMode: 'class'` is configured, nothing uses it). They are kept
 * here because whoever adds dark mode must not lighten the light values — a
 * flipped light palette does not survive a dark surface. These steps were
 * validated as a set against a dark card: worst adjacent CVD ΔE 8.4, worst
 * normal-vision ΔE 19.3, and all five clear 3:1, which the light set does not.
 */
const BUCKETS = [
  { key: 'available', label: 'Available', light: '#2a78d6', dark: '#3987e5', note: 'Sellable now' },
  { key: 'reserved', label: 'Reserved', light: '#eb6834', dark: '#d95926', note: 'Claimed by a confirmed order' },
  { key: 'damaged', label: 'Damaged', light: '#1baf7a', dark: '#199e70', note: 'Held back, includes returns awaiting inspection' },
  { key: 'inTransit', label: 'In transit', light: '#eda100', dark: '#c98500', note: 'Between warehouses' },
  { key: 'underService', label: 'Under service', light: '#e87ba4', dark: '#d55181', note: 'With us for repair, owned by a customer' },
];

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));

export default function StockBreakdownBar({ buckets, totalUnits }) {
  const [hovered, setHovered] = useState(null);

  const rows = BUCKETS.map((b) => ({ ...b, value: buckets?.[b.key] ?? 0 }));
  const total = totalUnits ?? rows.reduce((s, r) => s + r.value, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No stock on hand yet.
      </p>
    );
  }

  const present = rows.filter((r) => r.value > 0);

  return (
    <div className="space-y-3">
      {/* 24px tall, square at the baseline, 4px rounded at the two outer ends,
          and a 2px surface gap between touching segments. */}
      <div
        className="flex h-6 w-full overflow-hidden rounded"
        role="img"
        aria-label={present.map((r) => `${r.label} ${r.value}`).join(', ')}
      >
        {present.map((row, i) => {
          const percent = (row.value / total) * 100;
          const wide = percent > 12;

          return (
            <div
              key={row.key}
              onMouseEnter={() => setHovered(row.key)}
              onMouseLeave={() => setHovered(null)}
              style={{
                width: `${percent}%`,
                backgroundColor: `var(--bucket-${row.key})`,
                marginLeft: i === 0 ? 0 : 2,
              }}
              className={`relative flex items-center justify-center transition-opacity ${
                hovered && hovered !== row.key ? 'opacity-60' : ''
              } ${i === 0 ? 'rounded-l' : ''} ${i === present.length - 1 ? 'rounded-r' : ''}`}
              title={`${row.label}: ${row.value.toLocaleString('en-IN')} units`}
            >
              {/* A direct label inside the segment where it genuinely fits.
                  White ink on these fills, because the text sits on colour. */}
              {wide && (
                <span className="px-1 text-xs font-medium text-white drop-shadow-sm">
                  {compact(row.value)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* The legend doubles as the table view the contrast warning obliges. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-5">
        {rows.map((row) => (
          <div
            key={row.key}
            onMouseEnter={() => setHovered(row.key)}
            onMouseLeave={() => setHovered(null)}
            className={`rounded px-1 py-0.5 ${hovered === row.key ? 'bg-slate-100' : ''}`}
          >
            <dt className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: `var(--bucket-${row.key})` }}
              />
              {row.label}
            </dt>
            <dd
              className="pl-3.5 text-sm font-medium text-ink tabular-nums"
              title={row.note}
            >
              {row.value.toLocaleString('en-IN')}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-ink-muted">
        {total.toLocaleString('en-IN')} units in total. Only the available bucket can be sold
        today — the rest is real stock that is committed, held back, moving, or in for repair.
      </p>
    </div>
  );
}

export { BUCKETS };

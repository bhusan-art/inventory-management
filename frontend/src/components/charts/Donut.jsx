import { useId, useState } from 'react';

/**
 * A donut for part-to-whole.
 *
 * A stacked bar compares parts more accurately than any circle — angles are
 * harder to judge than lengths — so the numbers are printed next to every
 * slice rather than left to the geometry. The chart shows the shape of the
 * split; the legend answers "how many".
 *
 * The hole is not decoration: it holds the total, which is the number people
 * actually came for, and it removes the centre where a pie's slices are least
 * distinguishable anyway.
 *
 * COLOURS ARE NOT CHOSEN BY EYE. Both palettes were run through the
 * colour-blindness and contrast validator; the five-bucket set failed its
 * first arrangement — orange against yellow at ΔE 10.1, below the floor where
 * even full colour vision can separate them — and the orange was replaced.
 * Every slice also carries a visible label, which is what the validator's
 * contrast warning requires: two of these hues sit under 3:1 against white and
 * may not carry meaning alone.
 */

const TAU = Math.PI * 2;

function arcPath(cx, cy, rOuter, rInner, from, to) {
  // A full circle cannot be drawn as one arc — start and end coincide and the
  // path collapses. One slice at 100% is the normal case for a new system.
  const full = to - from >= TAU - 1e-6;
  const end = full ? from + TAU - 1e-6 : to;

  const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x1, y1] = p(rOuter, from);
  const [x2, y2] = p(rOuter, end);
  const [x3, y3] = p(rInner, end);
  const [x4, y4] = p(rInner, from);
  const large = end - from > Math.PI ? 1 : 0;

  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

export default function Donut({
  title, segments, totalLabel = 'Total', emptyMessage = 'Nothing recorded yet.',
}) {
  const titleId = useId();
  const [hovered, setHovered] = useState(null);

  const present = segments.filter((s) => Number(s.value) > 0);
  const total = present.reduce((sum, s) => sum + Number(s.value), 0);

  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 80;
  const rInner = 52;

  let angle = -Math.PI / 2; // start at twelve o'clock
  const arcs = present.map((segment) => {
    const sweep = (Number(segment.value) / total) * TAU;
    const path = arcPath(cx, cy, rOuter, rInner, angle, angle + sweep);
    angle += sweep;
    return { ...segment, path, share: Number(segment.value) / total };
  });

  return (
    <figure className="rounded-xl border border-line bg-white p-5">
      <figcaption id={titleId} className="text-sm font-semibold text-ink">
        {title}
      </figcaption>

      {total === 0 ? (
        <p className="mt-6 text-sm text-ink-muted">{emptyMessage}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-5">
          <svg
            width={size} height={size} viewBox={`0 0 ${size} ${size}`}
            role="img" aria-labelledby={titleId} className="shrink-0"
          >
            {arcs.map((arc) => (
              <path
                key={arc.label}
                d={arc.path}
                fill={arc.color}
                // A 2px surface-coloured ring separates neighbouring fills, so
                // two similar hues never touch edge to edge.
                stroke="#ffffff"
                strokeWidth="2"
                opacity={hovered && hovered !== arc.label ? 0.35 : 1}
                onMouseEnter={() => setHovered(arc.label)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>{`${arc.label}: ${arc.value} (${Math.round(arc.share * 100)}%)`}</title>
              </path>
            ))}

            <text
              x={cx} y={cy - 4} textAnchor="middle"
              className="fill-slate-900 text-2xl font-semibold"
              style={{ fontSize: 26 }}
            >
              {total.toLocaleString()}
            </text>
            <text
              x={cx} y={cy + 16} textAnchor="middle"
              className="fill-slate-500" style={{ fontSize: 11 }}
            >
              {totalLabel}
            </text>
          </svg>

          {/* The legend carries the numbers. Identity is never colour alone:
              every slice has a name and a value beside its swatch. */}
          <ul className="min-w-[11rem] flex-1 space-y-1.5">
            {arcs.map((arc) => (
              <li
                key={arc.label}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm ${
                  hovered === arc.label ? 'bg-paper' : ''
                }`}
                onMouseEnter={() => setHovered(arc.label)}
                onMouseLeave={() => setHovered(null)}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: arc.color }}
                />
                <span className="flex-1 truncate text-ink-soft">{arc.label}</span>
                <span className="font-medium text-ink">{arc.value.toLocaleString()}</span>
                <span className="w-10 text-right text-xs text-ink-muted">
                  {Math.round(arc.share * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </figure>
  );
}

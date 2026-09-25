import { useMemo, useState } from 'react';

// Reviews per week for the last 12 weeks, Genius-related stacked on the
// baseline with the other reviews on top. One accent hue + gray (the Genius
// series is the point; the rest is context), thin bars, a 2px surface gap
// between the two segments, hairline grid, hover/focus tooltip on every bar,
// a legend, and a table twin — the values never depend on hover alone.
const W = 640;
const H = 230;
const PAD = { top: 18, right: 10, bottom: 30, left: 34 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

function ticksFor(max) {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => max / s <= 5) || steps[steps.length - 1];
  const top = Math.max(step, Math.ceil(max / step) * step);
  const out = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return { top, ticks: out };
}

// A rect with rounded top corners and a square bottom (the data end is
// rounded, the baseline end is not).
function roundedTop(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr === 0) return `M${x},${y} h${w} v${h} h${-w} z`;
  return `M${x},${y + rr} a${rr},${rr} 0 0 1 ${rr},${-rr} h${w - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} h${-w} z`;
}

export default function TrendChart({ trend = [], onPickWeek, selected }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);

  const model = useMemo(() => {
    const max = Math.max(1, ...trend.map((t) => t.total || 0));
    const { top, ticks } = ticksFor(max);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const slot = trend.length ? plotW / trend.length : plotW;
    const barW = Math.min(MAX_BAR, Math.max(8, slot * 0.6));
    const baseline = PAD.top + plotH;
    const scale = (v) => (v / top) * plotH;
    const bars = trend.map((t, i) => {
      const x = PAD.left + i * slot + (slot - barW) / 2;
      const gh = scale(t.genius || 0);
      const oh = scale(t.other || 0);
      const gap = gh > 0 && oh > 0 ? GAP : 0;
      return { ...t, i, x, cx: x + barW / 2, slotX: PAD.left + i * slot, slot, barW, gh, oh, gap, top: baseline - gh - gap - oh };
    });
    return { top, ticks, plotH, baseline, bars, scale };
  }, [trend]);

  if (!trend.length) return null;
  const { ticks, baseline, bars, plotH } = model;
  const hovered = hover != null ? bars[hover] : null;
  const sel = selected ? bars.find((b) => b.start === selected.start) : null;

  return (
    <div className="rv-chart">
      <div className="rv-chart-head">
        <div className="rv-legend" aria-hidden="true">
          <span>
            <i style={{ background: 'var(--rv-genius)' }} /> Genius-related
          </span>
          <span>
            <i style={{ background: 'var(--rv-other)' }} /> Other reviews
          </span>
        </div>
        <button type="button" className="secondary small" onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {table ? (
        <table className="compact-table rv-trend-table">
          <thead>
            <tr>
              <th>Week of</th>
              <th>Genius-related</th>
              <th>Other</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((t) => (
              <tr key={t.start} onClick={onPickWeek ? () => onPickWeek(t) : undefined} style={onPickWeek ? { cursor: 'pointer' } : undefined}>
                <td>
                  {t.label}
                  {t.current ? <span className="muted"> · this week</span> : null}
                </td>
                <td>{t.genius}</td>
                <td>{t.other}</td>
                <td>{t.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Reviews per week, Genius-related versus other">
            {ticks.map((v) => {
              const y = baseline - model.scale(v);
              return (
                <g key={v}>
                  <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className={v === 0 ? 'rv-axis' : 'rv-grid'} />
                  <text x={PAD.left - 6} y={y + 3.5} textAnchor="end" className="rv-tick">
                    {v.toLocaleString()}
                  </text>
                </g>
              );
            })}
            {bars.map((b) => {
              const isHover = hover === b.i;
              const isSel = sel && sel.i === b.i;
              return (
                <g key={b.start} className={`rv-slot${isHover ? ' is-hover' : ''}${isSel ? ' is-selected' : ''}`}>
                  {b.gh > 0 && (
                    <path
                      className="seg seg-genius"
                      d={b.oh > 0 ? `M${b.x},${baseline - b.gh} h${b.barW} v${b.gh} h${-b.barW} z` : roundedTop(b.x, baseline - b.gh, b.barW, b.gh, RADIUS)}
                    />
                  )}
                  {b.oh > 0 && <path className="seg seg-other" d={roundedTop(b.x, b.top, b.barW, b.oh, RADIUS)} />}
                  {(isSel || (b.current && !sel)) && b.total > 0 && (
                    <text x={b.cx} y={b.top - 5} textAnchor="middle" className="rv-value">
                      {b.total}
                    </text>
                  )}
                  <text x={b.cx} y={H - 10} textAnchor="middle" className={`rv-xlabel${b.current || isSel ? ' is-strong' : ''}`}>
                    {b.label}
                  </text>
                  <rect
                    className="bar-hit"
                    x={b.slotX}
                    y={PAD.top}
                    width={b.slot}
                    height={plotH}
                    tabIndex={0}
                    role={onPickWeek ? 'button' : undefined}
                    aria-label={`Week of ${b.label}: ${b.genius} Genius-related, ${b.other} other`}
                    onMouseEnter={() => setHover(b.i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(b.i)}
                    onBlur={() => setHover(null)}
                    onClick={onPickWeek ? () => onPickWeek(b) : undefined}
                    onKeyDown={(e) => {
                      if (onPickWeek && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onPickWeek(b);
                      }
                    }}
                  />
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div className="rv-tooltip" style={{ left: `${(hovered.cx / W) * 100}%`, top: `${(Math.min(hovered.top, baseline - 8) / H) * 100}%` }}>
              <div className="rv-tooltip-title">
                Week of {hovered.label}
                {hovered.current ? ' (this week)' : ''}
              </div>
              <div>
                <b>{hovered.genius}</b> <span style={{ borderBottom: '2px solid var(--rv-genius)' }}>Genius-related</span>
              </div>
              <div>
                <b>{hovered.other}</b> <span style={{ borderBottom: '2px solid var(--rv-other)' }}>other</span>
              </div>
              <div className="muted-inverse">{hovered.total} total{onPickWeek ? ' · click to open' : ''}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

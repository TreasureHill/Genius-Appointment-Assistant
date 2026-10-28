import { useMemo, useState } from 'react';
import { fmtMoney } from './bits.jsx';
import './ct-admin.css';

// Monthly collected vs failed for the last 12 months (metrics.summary
// `chart`). Same build as reviews/TrendChart — hairline grid, thin rounded
// bars, hover/focus tooltip on every month, a legend and a table twin — but
// the two series sit side by side, not stacked: a failed charge is not part
// of what was collected, and stacking would read as a total.
const W = 640;
const H = 230;
const PAD = { top: 18, right: 10, bottom: 30, left: 48 };
const MAX_BAR = 14;
const PAIR_GAP = 2;
const RADIUS = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dollar ticks: a 1/2/5 step that gives at most 5 lines.
function ticksFor(maxCents) {
  const maxD = Math.max(1, maxCents / 100);
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  const step = steps.find((s) => maxD / s <= 5) || steps[steps.length - 1];
  const top = Math.max(step, Math.ceil(maxD / step) * step);
  const out = [];
  for (let v = 0; v <= top; v += step) out.push(v * 100);
  return { top: top * 100, ticks: out };
}

function roundedTop(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr === 0) return `M${x},${y} h${w} v${h} h${-w} z`;
  return `M${x},${y + rr} a${rr},${rr} 0 0 1 ${rr},${-rr} h${w - 2 * rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr} h${-w} z`;
}

// 'YYYY-MM' → "Nov" (and "Jan ’27" at a year boundary so the axis reads).
function monthLabel(m, i) {
  const [y, mo] = String(m).split('-').map(Number);
  const name = MONTHS[(mo || 1) - 1] || m;
  return i === 0 || mo === 1 ? `${name} ’${String(y).slice(2)}` : name;
}

function fmtTick(cents) {
  const d = cents / 100;
  return d >= 1000 ? `$${(d / 1000).toLocaleString()}k` : `$${d.toLocaleString()}`;
}

export default function ContractsChart({ chart = [] }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);

  const model = useMemo(() => {
    const max = Math.max(1, ...chart.map((c) => Math.max(c.paidCents || 0, c.failedCents || 0)));
    const { top, ticks } = ticksFor(max);
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const slot = chart.length ? plotW / chart.length : plotW;
    const barW = Math.min(MAX_BAR, Math.max(5, (slot * 0.62 - PAIR_GAP) / 2));
    const baseline = PAD.top + plotH;
    const scale = (v) => (v / top) * plotH;
    const bars = chart.map((c, i) => {
      const slotX = PAD.left + i * slot;
      const x = slotX + (slot - (barW * 2 + PAIR_GAP)) / 2;
      const ph = scale(c.paidCents || 0);
      const fh = scale(c.failedCents || 0);
      return { ...c, i, slotX, slot, x, barW, ph, fh, cx: slotX + slot / 2, top: baseline - Math.max(ph, fh), label: monthLabel(c.month, i) };
    });
    return { ticks, baseline, plotH, bars, scale };
  }, [chart]);

  if (!chart.length) return <div className="muted" style={{ fontSize: 13 }}>No payments yet.</div>;
  const { ticks, baseline, bars, plotH } = model;
  const hovered = hover != null ? bars[hover] : null;
  const last = bars.length - 1;

  return (
    <div className="rv-chart ct-chart">
      <div className="rv-chart-head">
        <div className="rv-legend" aria-hidden="true">
          <span>
            <i style={{ background: 'var(--ct-paid)' }} /> Collected
          </span>
          <span>
            <i style={{ background: 'var(--ct-failed)' }} /> Failed
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
              <th>Month</th>
              <th>Collected</th>
              <th>Payments</th>
              <th>Failed</th>
              <th>Failed charges</th>
            </tr>
          </thead>
          <tbody>
            {chart.map((c) => (
              <tr key={c.month}>
                <td>{c.month}</td>
                <td>{fmtMoney(c.paidCents || 0)}</td>
                <td>{c.paidCount || 0}</td>
                <td>{fmtMoney(c.failedCents || 0)}</td>
                <td>{c.failedCount || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monitoring payments per month, collected versus failed">
            {ticks.map((v) => {
              const y = baseline - model.scale(v);
              return (
                <g key={v}>
                  <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className={v === 0 ? 'rv-axis' : 'rv-grid'} />
                  <text x={PAD.left - 6} y={y + 3.5} textAnchor="end" className="rv-tick">
                    {fmtTick(v)}
                  </text>
                </g>
              );
            })}
            {bars.map((b) => (
              <g key={b.month} className={`rv-slot${hover === b.i ? ' is-hover' : ''}`}>
                {b.ph > 0 && <path className="seg seg-paid" d={roundedTop(b.x, baseline - b.ph, b.barW, b.ph, RADIUS)} />}
                {b.fh > 0 && <path className="seg seg-failed" d={roundedTop(b.x + b.barW + PAIR_GAP, baseline - b.fh, b.barW, b.fh, RADIUS)} />}
                <text x={b.cx} y={H - 10} textAnchor="middle" className={`rv-xlabel${b.i === last ? ' is-strong' : ''}`}>
                  {b.label}
                </text>
                <rect
                  className="bar-hit"
                  x={b.slotX}
                  y={PAD.top}
                  width={b.slot}
                  height={plotH}
                  tabIndex={0}
                  aria-label={`${b.month}: collected ${fmtMoney(b.paidCents || 0)} in ${b.paidCount || 0} payments, failed ${fmtMoney(b.failedCents || 0)}`}
                  onMouseEnter={() => setHover(b.i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(b.i)}
                  onBlur={() => setHover(null)}
                  style={{ cursor: 'default' }}
                />
              </g>
            ))}
          </svg>
          {hovered && (
            <div className="rv-tooltip" style={{ left: `${(hovered.cx / W) * 100}%`, top: `${(Math.min(hovered.top, baseline - 8) / H) * 100}%` }}>
              <div className="rv-tooltip-title">{hovered.month}</div>
              <div>
                <b>{fmtMoney(hovered.paidCents || 0)}</b> <span style={{ borderBottom: '2px solid var(--ct-paid)' }}>collected</span>{' '}
                <span className="muted-inverse">({hovered.paidCount || 0})</span>
              </div>
              <div>
                <b>{fmtMoney(hovered.failedCents || 0)}</b> <span style={{ borderBottom: '2px solid var(--ct-failed)' }}>failed</span>{' '}
                <span className="muted-inverse">({hovered.failedCount || 0})</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

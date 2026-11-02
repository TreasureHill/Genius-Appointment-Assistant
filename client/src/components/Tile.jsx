import { Link } from 'react-router-dom';

// One stat tile (.tiles > .tile). Merges the three local variants (Dashboard:
// `to` link; Reviews: `onClick` + hint; Board: `active` filter). New screens
// use this one; the older pages keep their own copies for now.
//   accent: 'ok' | 'err' | 'warn'   (tile-ok / tile-err / tile-warn)
//   active: highlights the tile when it is the filter being applied
export default function Tile({ label, value, hint, accent, to, onClick, active, title }) {
  const clickable = Boolean(to || onClick);
  const style = {
    ...(clickable ? { cursor: 'pointer' } : {}),
    ...(active ? { borderColor: 'var(--primary)', boxShadow: '0 0 0 1px var(--primary)' } : {}),
  };
  const inner = (
    <div
      className={`tile${accent ? ` tile-${accent}` : ''}`}
      onClick={to ? undefined : onClick}
      role={onClick && !to ? 'button' : undefined}
      tabIndex={onClick && !to ? 0 : undefined}
      aria-pressed={onClick && !to && active != null ? Boolean(active) : undefined}
      onKeyDown={
        onClick && !to
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={style}
      title={to ? undefined : title}
    >
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
      {hint && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
  if (!to) return inner;
  return (
    <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }} title={title || 'Open'}>
      {inner}
    </Link>
  );
}

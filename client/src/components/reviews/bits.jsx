import { api } from '../../api';

// Small pieces shared by the Reviews tab.

export function Stars({ rating, title }) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return (
    <span className="stars" aria-label={`${n} of 5 stars`} title={title || `${n} of 5 stars`}>
      {'★'.repeat(n)}
      <span className="off">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

export function RepBadge({ rep, inactive }) {
  if (!rep) return null;
  const name = typeof rep === 'string' ? rep : rep.name;
  const color = (typeof rep === 'object' && rep.color) || '#94a3b8';
  return (
    <span className={`rep-badge${inactive ? ' is-inactive' : ''}`} title={inactive ? `${name} (inactive rep)` : name}>
      <i style={{ background: color }} aria-hidden="true" />
      {name}
    </span>
  );
}

export const plural = (n, word, pluralWord) => `${Number(n).toLocaleString()} ${n === 1 ? word : pluralWord || `${word}s`}`;

// "Sep 14" this year, "Sep 14, 2025" otherwise — dates only, in the schedule zone.
export function fmtReviewDate(d, tz) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const opts = { month: 'short', day: 'numeric' };
  try {
    const zone = tz || undefined;
    const year = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' }).format(date);
    const thisYear = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' }).format(new Date());
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, ...opts, ...(year === thisYear ? {} : { year: 'numeric' }) }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(date);
  }
}

// Fetch a file through the API (cookie auth) and trigger a browser download.
export async function downloadFile(url, fallbackName) {
  const res = await api.raw(url);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      msg = data.error || data.message || msg;
    } catch {
      /* not json */
    }
    throw new Error(msg || 'Download failed');
  }
  const disposition = res.headers.get('content-disposition') || '';
  const m = /filename="?([^";]+)"?/i.exec(disposition);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = (m && m[1]) || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export const idOf = (x) => (x && typeof x === 'object' ? String(x._id) : String(x));

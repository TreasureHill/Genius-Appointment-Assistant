// Small display helpers for the inbox.

export function initials(person) {
  const name = String(person?.name || '').trim();
  if (name) {
    const parts = name.replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
    return letters.toUpperCase();
  }
  return String(person?.email || '?').slice(0, 1).toUpperCase();
}

const AVATAR_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#0d9488', '#ea580c', '#2563eb', '#9333ea'];

export function avatarColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function displayName(person) {
  if (!person) return '';
  if (person.name) return person.name;
  return person.email || '';
}

export function firstName(person) {
  const name = String(person?.name || '').trim();
  if (name) return name.includes(',') ? name.split(',')[1].trim().split(/\s+/)[0] : name.split(/\s+/)[0];
  const local = String(person?.email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : '';
}

export function formatAddress(a) {
  if (!a?.email) return '';
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// AI drafts arrive as plain text: blank lines split paragraphs. Each line
// becomes a <p> and a paragraph break an empty <p><br></p> — the same markup
// the editor produces when you type, so it looks identical in Outlook (which
// gives <p> no margin) and Gmail.
export function textToHtml(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!t) return '';
  return t
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split('\n')
        .map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`)
        .join('')
    )
    .join('<p><br></p>');
}

export function htmlToPlain(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html || '')
    .replace(/<p[^>]*>\s*<br\s*\/?>\s*<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n');
  return (div.textContent || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// "2:14 PM" today, "Tue" this week, "Oct 3" this year, "Oct 3, 2025" older.
export function listTime(d, tz) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  const zone = tz || undefined;
  const fmt = (opts) => {
    try {
      return new Intl.DateTimeFormat(undefined, { timeZone: zone, ...opts }).format(date);
    } catch {
      return new Intl.DateTimeFormat(undefined, opts).format(date);
    }
  };
  const key = (x) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(x);
    } catch {
      return x.toDateString();
    }
  };
  if (key(date) === key(now)) return fmt({ hour: 'numeric', minute: '2-digit' });
  const days = (now - date) / 864e5;
  if (days < 6.5 && days > 0) return fmt({ weekday: 'short' });
  if (date.getFullYear() === now.getFullYear()) return fmt({ month: 'short', day: 'numeric' });
  return fmt({ month: 'short', day: 'numeric', year: 'numeric' });
}

export function fullTime(d, tz) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(d));
  } catch {
    return new Date(d).toLocaleString();
  }
}

export function Avatar({ person, size = 32 }) {
  const color = avatarColor(person?.email || person?.name);
  return (
    <span
      className="mail-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: color }}
      aria-hidden="true"
    >
      {initials(person)}
    </span>
  );
}

export const LOT_STATUS_LABEL = {
  pending: 'Pending',
  contacted: 'Contacted',
  scheduled: 'Scheduled',
  completed: 'Completed',
  opted_out: 'Opted out',
};

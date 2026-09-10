// Time formatting for the whole app.
//
// Every scheduled time (queue, lot page, settings preview) is shown in the
// sending-schedule timezone — Settings → Sending schedule — never in the
// browser's zone, so what the owner typed ("09:00") and what the queue shows
// always agree. Every helper falls back to the browser's zone when no valid
// zone is given, so nothing breaks before settings have loaded.

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function safeTz(tz) {
  return isValidTimezone(tz) ? tz : browserTimezone();
}

function toDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MS_DAY = 24 * 60 * 60 * 1000;

// Calendar fields of an instant in `tz`: { year, month (1-12), day, weekday (0=Sun), hour, minute }
export function zonedParts(d, tz) {
  const date = toDate(d) || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const out = {};
  for (const p of parts) {
    if (p.type === 'weekday') out.weekday = idx[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

// 'YYYY-MM-DD' of an instant in `tz` — the grouping key for "same day".
export function dateKey(d, tz) {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export function weekdayKeyInTz(d, tz) {
  return DAY_KEYS[zonedParts(d, tz).weekday];
}

// "9:00 AM" / "9:00 PM"
export function fmtTime(d, tz) {
  const date = toDate(d);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone: safeTz(tz), hour: 'numeric', minute: '2-digit' }).format(date);
}

// "Sep 10, 9:00 AM" — adds the year only when it isn't this year.
export function fmtDateTime(d, tz, opts = {}) {
  const date = toDate(d);
  if (!date) return '—';
  const zone = safeTz(tz);
  const sameYear = zonedParts(date, zone).year === zonedParts(new Date(), zone).year;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    ...opts,
  }).format(date);
}

// "Thu, Sep 10"
export function fmtDate(d, tz, opts = {}) {
  const date = toDate(d);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, { timeZone: safeTz(tz), weekday: 'short', month: 'short', day: 'numeric', ...opts }).format(date);
}

// "Today", "Tomorrow", "Yesterday", else "Thu, Sep 10".
export function fmtDayLabel(d, tz, now = new Date()) {
  const date = toDate(d);
  if (!date) return '—';
  const zone = safeTz(tz);
  const key = dateKey(date, zone);
  if (key === dateKey(now, zone)) return 'Today';
  if (key === dateKey(new Date(now.getTime() + MS_DAY), zone)) return 'Tomorrow';
  if (key === dateKey(new Date(now.getTime() - MS_DAY), zone)) return 'Yesterday';
  return fmtDate(date, zone);
}

// "in 12 min", "in 2 h 5 min", "in 3 days", "5 min ago", "now"
export function relativeTime(d, now = new Date()) {
  const date = toDate(d);
  if (!date) return '';
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const future = diff > 0;
  let text;
  if (abs < 45 * 1000) return 'now';
  if (abs < 60 * 60 * 1000) text = `${Math.round(abs / 60000)} min`;
  else if (abs < 24 * 60 * 60 * 1000) {
    const h = Math.floor(abs / 3600000);
    const m = Math.round((abs - h * 3600000) / 60000);
    text = m ? `${h} h ${m} min` : `${h} h`;
  } else {
    const days = Math.round(abs / MS_DAY);
    text = `${days} day${days === 1 ? '' : 's'}`;
  }
  return future ? `in ${text}` : `${text} ago`;
}

// "EDT" / "EST" / "GMT+5"
export function tzAbbrev(tz, d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeTz(tz), timeZoneName: 'short' }).formatToParts(toDate(d) || new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

// "09:00" → "9:00 AM"
export function fmtClock(hm) {
  if (!hm || typeof hm !== 'string') return '';
  const [h, m] = hm.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return hm;
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(d);
}

// The next `count` calendar days in `tz`, starting today. Uses pure calendar
// arithmetic (noon-UTC anchors) so DST days never get skipped or doubled.
export function calendarDays(tz, count = 7, now = new Date()) {
  const zone = safeTz(tz);
  const p = zonedParts(now, zone);
  const out = [];
  for (let i = 0; i < count; i++) {
    const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
    out.push({
      key: `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}-${String(anchor.getUTCDate()).padStart(2, '0')}`,
      weekdayKey: DAY_KEYS[anchor.getUTCDay()],
      label: new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(anchor),
      isToday: i === 0,
    });
  }
  return out;
}

// All IANA zones the browser knows, else a short practical list.
const COMMON_TIMEZONES = [
  'America/Toronto',
  'America/New_York',
  'America/Halifax',
  'America/St_Johns',
  'America/Winnipeg',
  'America/Chicago',
  'America/Regina',
  'America/Edmonton',
  'America/Denver',
  'America/Vancouver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Australia/Sydney',
  'UTC',
];
export function timezoneOptions() {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all && all.length ? all : COMMON_TIMEZONES;
  } catch {
    return COMMON_TIMEZONES;
  }
}

// Send windows ("09:00" to "21:00", per weekday) are wall-clock times in ONE
// explicit IANA timezone: Settings → Sending schedule → Timezone. Everything
// below converts between instants (Date) and that zone with Intl, so the
// server's own clock never matters. A 9 AM window means 9 AM in Toronto
// whether the box runs in UTC, Pacific, or anywhere else — which is exactly
// the bug the old getHours()/setHours() version had ("I set 9 AM, the queue
// says 12").

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_TIMEZONE = 'America/New_York';
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The zone a Setting document schedules in: the explicit schedule timezone,
// else Aria's spoken-time zone (same owner, same office), else Eastern.
function resolveScheduleTimezone(setting) {
  const candidates = [setting?.schedule?.timezone, setting?.aria?.timezone, DEFAULT_TIMEZONE];
  for (const c of candidates) if (isValidTimezone(c)) return c;
  return 'UTC';
}

function parseHM(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, m] = s.split(':').map((n) => Number(n));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function plain(sendWindows) {
  if (!sendWindows) return null;
  return sendWindows.toObject ? sendWindows.toObject() : sendWindows;
}

const partsFormatters = new Map();
function partsFormatter(tz) {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

// Wall-clock fields of an instant in `tz`:
// { year, month (1-12), day, weekday (0=Sun), hour (0-23), minute, second }
function zonedParts(date, tz = DEFAULT_TIMEZONE) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type === 'weekday') out.weekday = WEEKDAY_INDEX[p.value];
    else if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

// Offset (ms) of `tz` at the given instant: wall-clock-as-UTC minus instant.
function offsetAt(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant at which `tz` reads year-month-day hour:minute. Pretend the
// wall-clock time is UTC, subtract the zone's offset, and re-check once so DST
// boundaries land right. A time that doesn't exist (spring-forward gap)
// resolves to the later instant, so nothing ever sends before the wall-clock
// time the owner typed.
function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, tz = DEFAULT_TIMEZONE) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const off1 = offsetAt(new Date(wall), tz);
  const off2 = offsetAt(new Date(wall - off1), tz);
  return new Date(wall - Math.min(off1, off2));
}

// Calendar date `i` days after the date in `p` (from zonedParts).
function calendarDayAfter(p, i) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

function startOfDayInTimezone(date = new Date(), tz = DEFAULT_TIMEZONE) {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
}

function getDayWindow(sendWindows, weekday) {
  const sw = plain(sendWindows);
  if (!sw) return null;
  return sw[DAY_KEYS[weekday]] || null;
}

// Is `now` inside the configured send window for that weekday (in `tz`)?
// Falls back to "open" when sendWindows isn't configured at all.
function isWithinSendWindow(sendWindows, now = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!sendWindows) return true;
  const p = zonedParts(now, tz);
  const win = getDayWindow(sendWindows, p.weekday);
  if (!win || !win.enabled) return false;
  const startMins = parseHM(win.start);
  const endMins = parseHM(win.end);
  if (startMins == null || endMins == null) return true;
  const mins = p.hour * 60 + p.minute;
  if (startMins <= endMins) return mins >= startMins && mins < endMins;
  // Window wraps midnight (e.g. 22:00 → 02:00)
  return mins >= startMins || mins < endMins;
}

// First instant at-or-after `from` that lands inside an enabled send window.
// Returns `from` itself when it's already inside one, null when every day is
// disabled. Scans 14 days ahead so a single enabled weekday still resolves.
function nextSendOpening(sendWindows, from = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!sendWindows) return from;
  if (isWithinSendWindow(sendWindows, from, tz)) return from;
  const p = zonedParts(from, tz);
  for (let i = 0; i < 14; i++) {
    const cal = calendarDayAfter(p, i);
    const win = getDayWindow(sendWindows, cal.weekday);
    if (!win || !win.enabled) continue;
    const startMins = parseHM(win.start);
    if (startMins == null) continue;
    const start = zonedTimeToUtc(
      { year: cal.year, month: cal.month, day: cal.day, hour: Math.floor(startMins / 60), minute: startMins % 60 },
      tz
    );
    if (start.getTime() > from.getTime()) return start;
  }
  return null;
}

// When does the window we're currently inside close? Null when closed.
function currentWindowEnd(sendWindows, now = new Date(), tz = DEFAULT_TIMEZONE) {
  if (!sendWindows || !isWithinSendWindow(sendWindows, now, tz)) return null;
  const p = zonedParts(now, tz);
  const win = getDayWindow(sendWindows, p.weekday);
  const startMins = parseHM(win && win.start);
  const endMins = parseHM(win && win.end);
  if (startMins == null || endMins == null) return null; // open-ended day
  const mins = p.hour * 60 + p.minute;
  // A wrap-around window that we entered before midnight ends tomorrow.
  const dayOffset = startMins > endMins && mins >= startMins ? 1 : 0;
  const cal = calendarDayAfter(p, dayOffset);
  return zonedTimeToUtc(
    { year: cal.year, month: cal.month, day: cal.day, hour: Math.floor(endMins / 60), minute: endMins % 60 },
    tz
  );
}

// One object the UI can render as "Open until 9:00 PM" / "Closed — opens
// Thu 9:00 AM". `enabledDays` tells the Queue page whether sending is
// switched off entirely.
function windowStatus(sendWindows, now = new Date(), tz = DEFAULT_TIMEZONE) {
  const sw = plain(sendWindows);
  const enabledDays = sw ? DAY_KEYS.filter((k) => sw[k] && sw[k].enabled) : DAY_KEYS.slice();
  const open = isWithinSendWindow(sendWindows, now, tz);
  const p = zonedParts(now, tz);
  const today = getDayWindow(sendWindows, p.weekday);
  return {
    timezone: tz,
    now: now.toISOString(),
    open,
    closesAt: open ? currentWindowEnd(sendWindows, now, tz)?.toISOString() || null : null,
    nextOpening: open ? null : nextSendOpening(sendWindows, now, tz)?.toISOString() || null,
    enabledDays,
    today: today
      ? { dayKey: DAY_KEYS[p.weekday], enabled: !!today.enabled, start: today.start || '', end: today.end || '' }
      : { dayKey: DAY_KEYS[p.weekday], enabled: true, start: '', end: '' },
  };
}

// A `count`-day preview (default 7) starting on `from`'s date in `tz`, with the
// exact instants each day's window opens and closes.
function previewWindows(sendWindows, from = new Date(), count = 7, tz = DEFAULT_TIMEZONE) {
  const sw = plain(sendWindows);
  const p = zonedParts(from, tz);
  const out = [];
  for (let i = 0; i < count; i++) {
    const cal = calendarDayAfter(p, i);
    const dayKey = DAY_KEYS[cal.weekday];
    const win = sw ? sw[dayKey] : null;
    const enabled = !!(win && win.enabled);
    const startMins = enabled ? parseHM(win.start) : null;
    const endMins = enabled ? parseHM(win.end) : null;
    const at = (mins) =>
      mins == null
        ? null
        : zonedTimeToUtc(
            { year: cal.year, month: cal.month, day: cal.day, hour: Math.floor(mins / 60), minute: mins % 60 },
            tz
          ).toISOString();
    out.push({
      date: `${cal.year}-${String(cal.month).padStart(2, '0')}-${String(cal.day).padStart(2, '0')}`,
      dayKey,
      enabled,
      start: enabled && win.start ? win.start : '',
      end: enabled && win.end ? win.end : '',
      opensAt: at(startMins),
      closesAt: at(endMins),
    });
  }
  return out;
}

// "Thu, Sep 10, 9:00 AM EDT" — for logs and API messages.
function formatInTimezone(date, tz = DEFAULT_TIMEZONE, opts = {}) {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      ...opts,
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

module.exports = {
  DAY_KEYS,
  DEFAULT_TIMEZONE,
  isValidTimezone,
  resolveScheduleTimezone,
  parseHM,
  zonedParts,
  zonedTimeToUtc,
  startOfDayInTimezone,
  isWithinSendWindow,
  nextSendOpening,
  currentWindowEnd,
  windowStatus,
  previewWindows,
  formatInTimezone,
};

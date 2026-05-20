const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseHM(s) {
  if (!s || typeof s !== 'string') return null;
  const [h, m] = s.split(':').map((n) => Number(n));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function getDayWindow(sendWindows, date) {
  if (!sendWindows) return null;
  const sw = sendWindows.toObject ? sendWindows.toObject() : sendWindows;
  return sw[DAY_KEYS[date.getDay()]] || null;
}

// Is `now` inside the configured send window for that weekday?
// Falls back to "open" when sendWindows isn't configured at all.
function isWithinSendWindow(sendWindows, now = new Date()) {
  if (!sendWindows) return true;
  const win = getDayWindow(sendWindows, now);
  if (!win || !win.enabled) return false;
  const startMins = parseHM(win.start);
  const endMins = parseHM(win.end);
  if (startMins == null || endMins == null) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (startMins <= endMins) return mins >= startMins && mins < endMins;
  // Window wraps midnight (e.g. 22:00 → 02:00)
  return mins >= startMins || mins < endMins;
}

// First Date at-or-after `from` that lands inside an enabled send window.
// Returns `from` if it's already inside one. Returns null if every day is
// disabled. Scans up to 14 days ahead to find the next opening.
function nextSendOpening(sendWindows, from = new Date()) {
  if (!sendWindows) return from;
  if (isWithinSendWindow(sendWindows, from)) return from;
  for (let i = 0; i < 14; i++) {
    const probe = new Date(from);
    probe.setDate(probe.getDate() + i);
    const win = getDayWindow(sendWindows, probe);
    if (!win || !win.enabled) continue;
    const startMins = parseHM(win.start);
    if (startMins == null) continue;
    const startOfDay = new Date(probe);
    startOfDay.setHours(Math.floor(startMins / 60), startMins % 60, 0, 0);
    if (startOfDay.getTime() > from.getTime()) return startOfDay;
    // Same day, current time is past the window — also handle wrap-around
    // by checking that we're not already inside it (handled above).
    const endMins = parseHM(win.end);
    if (endMins != null && startMins > endMins) {
      // Wrap: window ends tomorrow morning; treat tomorrow's start instead.
      continue;
    }
  }
  return null;
}

// Build a `count`-day preview (default 7) starting from `from`. Useful for
// the Settings UI to show what the schedule will actually do this week.
function previewWindows(sendWindows, from = new Date(), count = 7) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const dayKey = DAY_KEYS[d.getDay()];
    const win = sendWindows ? (sendWindows.toObject ? sendWindows.toObject() : sendWindows)[dayKey] : null;
    out.push({
      date: d,
      dayKey,
      enabled: !!(win && win.enabled),
      start: win && win.start ? win.start : '',
      end: win && win.end ? win.end : '',
    });
  }
  return out;
}

module.exports = { DAY_KEYS, isWithinSendWindow, nextSendOpening, previewWindows };

// The numbers behind the Reviews tab, the weekly deck and the Excel export.
//
// Pure: pass in the reviews (with their EFFECTIVE reps / genius flags), the
// reps, and the window; get back every figure the page shows. Week boundaries
// are calendar days in the schedule timezone (Settings → Sending schedule),
// never the server's clock.
const { zonedParts, zonedTimeToUtc } = require('../sendWindow');

const MS_DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

const ymd = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

function addDays(p, n) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n, 12));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// 0 = Sunday … 6 = Saturday
function weekdayOf(p) {
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
}

function mondayOf(p) {
  return addDays(p, -((weekdayOf(p) + 6) % 7));
}

function cmp(a, b) {
  return ymd(a) < ymd(b) ? -1 : ymd(a) > ymd(b) ? 1 : 0;
}

const dayStart = (p, tz) => zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);

function todayIn(tz, now = new Date()) {
  const p = zonedParts(now, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// "September 14 – 18, 2026" / "August 31 – September 6, 2026" / across years
function formatRange(start, end) {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e) return `${start} – ${end}`;
  const month = (p) => new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  if (s.year !== e.year) return `${month(s)} ${s.day}, ${s.year} – ${month(e)} ${e.day}, ${e.year}`;
  if (s.month !== e.month) return `${month(s)} ${s.day} – ${month(e)} ${e.day}, ${e.year}`;
  if (s.day === e.day) return `${month(s)} ${s.day}, ${s.year}`;
  return `${month(s)} ${s.day} – ${e.day}, ${e.year}`;
}

// The reporting window. Default = Monday of the current week through today
// (the shape of the manual Mon–Fri deck). Past weeks run Monday–Sunday so a
// weekend review still lands in a week. `start` / `end` are 'YYYY-MM-DD'.
function resolveWindow({ tz = 'UTC', start, end, now = new Date() } = {}) {
  const today = todayIn(tz, now);
  const thisMonday = mondayOf(today);
  let s = start ? parseYmd(start) : null;
  let e = end ? parseYmd(end) : null;
  if (!s && !e) {
    s = thisMonday;
    e = today;
  } else if (s && !e) {
    e = addDays(s, 6);
    if (cmp(e, today) > 0) e = today;
    if (cmp(e, s) < 0) e = s;
  } else if (!s && e) {
    s = mondayOf(e);
  }
  if (cmp(s, e) > 0) [s, e] = [e, s];
  const startKey = ymd(s);
  const endKey = ymd(e);
  return {
    start: startKey,
    end: endKey,
    startAt: dayStart(s, tz),
    endAt: dayStart(addDays(e, 1), tz), // exclusive
    label: formatRange(startKey, endKey),
    isCurrentWeek: startKey === ymd(thisMonday) && endKey === ymd(today),
    today: ymd(today),
    // Navigation targets for the page (previous / next week, this week).
    prev: (() => {
      const m = mondayOf(s);
      const ps = addDays(m, -7);
      return { start: ymd(ps), end: ymd(addDays(ps, 6)) };
    })(),
    next: (() => {
      const ns = addDays(mondayOf(s), 7);
      if (cmp(ns, today) > 0) return null;
      const ne = addDays(ns, 6);
      return { start: ymd(ns), end: ymd(cmp(ne, today) > 0 ? today : ne) };
    })(),
  };
}

const idStr = (x) => (x && x._id ? String(x._id) : String(x));

const avg = (sum, n) => (n ? Math.round((sum / n) * 100) / 100 : 0);

function ratingMix(list) {
  const out = [0, 0, 0, 0, 0];
  for (const r of list) {
    const k = Math.min(5, Math.max(1, Math.round(Number(r.rating) || 0)));
    out[k - 1] += 1;
  }
  return out;
}

function summarize(list) {
  const n = list.length;
  const genius = list.filter((r) => r.genius);
  const sum = (l) => l.reduce((a, r) => a + (Number(r.rating) || 0), 0);
  return {
    total: n,
    genius: genius.length,
    other: n - genius.length,
    fiveStar: list.filter((r) => Number(r.rating) === 5).length,
    geniusFiveStar: genius.filter((r) => Number(r.rating) === 5).length,
    avgRating: avg(sum(list), n),
    geniusAvgRating: avg(sum(genius), genius.length),
    lowRated: list.filter((r) => Number(r.rating) > 0 && Number(r.rating) <= 3).length,
    unreplied: list.filter((r) => !(r.reply && r.reply.text)).length,
    lowUnreplied: list.filter((r) => Number(r.rating) > 0 && Number(r.rating) <= 3 && !(r.reply && r.reply.text)).length,
    // Genius-related but credited to nobody — the ones to map by hand.
    unmapped: genius.filter((r) => !(r.reps && r.reps.length)).length,
    manual: list.filter((r) => r.mappingSource === 'manual').length,
    ratings: ratingMix(list),
    geniusRatings: ratingMix(genius),
  };
}

// The most descriptive top-rated reviews of the week for one rep.
function highlights(list, limit = 2, minRating = 5) {
  const pool = list.filter((r) => Number(r.rating) >= minRating);
  return (pool.length ? pool : list)
    .slice()
    .sort((a, b) => String(b.text || '').length - String(a.text || '').length)
    .slice(0, limit);
}

// reviews: [{ rating, text, effectiveAt, reps: [id], genius, reply, mappingSource, … }]
// reps:    [{ _id, name, color, active, sortOrder }]
function computeStats({ reviews = [], reps = [], window, tz = 'UTC', now = new Date(), trendWeeks = 12 } = {}) {
  const win = window || resolveWindow({ tz, now });
  const startMs = win.startAt.getTime();
  const endMs = win.endAt.getTime();
  const at = (r) => new Date(r.effectiveAt).getTime();
  const inWindow = (r) => at(r) >= startMs && at(r) < endMs;

  const week = reviews.filter(inWindow).sort((a, b) => at(b) - at(a));

  const repRows = reps
    .filter((rep) => rep.active !== false)
    .map((rep) => {
      const id = idStr(rep);
      const mine = reviews.filter((r) => (r.reps || []).some((x) => idStr(x) === id));
      const mineWeek = mine.filter(inWindow).sort((a, b) => at(b) - at(a));
      const sum = mine.reduce((a, r) => a + (Number(r.rating) || 0), 0);
      return {
        _id: id,
        name: rep.name,
        color: rep.color || '',
        role: rep.role || '',
        week: mineWeek.length,
        weekFiveStar: mineWeek.filter((r) => Number(r.rating) === 5).length,
        allTime: mine.length,
        allTimeFiveStar: mine.filter((r) => Number(r.rating) === 5).length,
        avgRating: avg(sum, mine.length),
        highlights: highlights(mineWeek).map((r) => ({
          _id: r._id ? String(r._id) : undefined,
          reviewer: r.reviewer,
          rating: r.rating,
          text: r.text,
          effectiveAt: r.effectiveAt,
        })),
      };
    })
    .sort((a, b) => b.week - a.week || b.allTime - a.allTime || a.name.localeCompare(b.name));

  // Weekly buckets ending with the window's week (Mon–Sun), oldest first.
  const trend = [];
  const endWeekMonday = mondayOf(parseYmd(win.end));
  for (let i = trendWeeks - 1; i >= 0; i--) {
    const s = addDays(endWeekMonday, -7 * i);
    const e = addDays(s, 6);
    const sMs = dayStart(s, tz).getTime();
    const eMs = dayStart(addDays(e, 1), tz).getTime();
    const bucket = reviews.filter((r) => at(r) >= sMs && at(r) < eMs);
    const genius = bucket.filter((r) => r.genius).length;
    trend.push({
      start: ymd(s),
      end: ymd(e),
      label: new Date(Date.UTC(s.year, s.month - 1, s.day, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      genius,
      other: bucket.length - genius,
      total: bucket.length,
      current: i === 0,
    });
  }

  return {
    window: win,
    timezone: tz,
    week: summarize(week),
    allTime: summarize(reviews),
    reps: repRows,
    trend,
    // The week's reviews themselves (already effective-tagged) for the deck /
    // export; the page lists them through the paginated endpoint instead.
    weekReviews: week,
  };
}

module.exports = { resolveWindow, computeStats, formatRange, parseYmd, addDays, mondayOf, ymd, todayIn, dayStart };

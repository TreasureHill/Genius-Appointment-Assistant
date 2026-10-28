// Billing calendar helpers — pure (no DB, no network). Used by the payment
// reminder worker, metrics (months active) and the card-expiry notice.
// Calendar maths happens in the schedule timezone (Settings → Sending
// schedule), so "3 days before" means three Toronto calendar days whatever the
// server clock or DST says.
//
// Owner: reminders track (tests: contractSchedule.test.js). Foundation shipped
// working versions so the signatures are settled; refine freely.

const { zonedParts, isWithinSendWindow, DEFAULT_TIMEZONE } = require('../sendWindow');

const MS_DAY = 24 * 60 * 60 * 1000;

const toDate = (d) => (d == null ? null : d instanceof Date ? d : new Date(d));

// Calendar day of an instant in `tz`, as a comparable UTC-midnight number.
function dayNumber(date, tz) {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day);
}

/**
 * The calendar day (in tz) on which the upcoming-payment reminder becomes due:
 * `daysBefore` calendar days before the charge date. Returned as the instant
 * of that day's 00:00 UTC-equivalent number (only for comparisons).
 * @returns {number|null}
 */
function reminderDay({ periodEnd, daysBefore = 3, tz = DEFAULT_TIMEZONE }) {
  const pe = toDate(periodEnd);
  if (!pe || Number.isNaN(pe.getTime())) return null;
  return dayNumber(pe, tz) - Math.max(0, Number(daysBefore) || 0) * MS_DAY;
}

/**
 * Is the "upcoming payment" reminder due for this billing period?
 * True from the start of the reminder day (tz calendar) until the charge
 * itself, unless this exact period end was already reminded about.
 * @param {{periodEnd: Date|string, daysBefore: number, now?: Date, tz?: string, lastRemindedPeriodEnd?: Date|string|null}} a
 * @returns {boolean}
 */
function isReminderDue({ periodEnd, daysBefore = 3, now = new Date(), tz = DEFAULT_TIMEZONE, lastRemindedPeriodEnd = null }) {
  const pe = toDate(periodEnd);
  if (!pe || Number.isNaN(pe.getTime())) return false;
  const n = toDate(now);
  if (n.getTime() >= pe.getTime()) return false; // the charge already happened
  const last = toDate(lastRemindedPeriodEnd);
  if (last && last.getTime() === pe.getTime()) return false; // already reminded for this period
  return dayNumber(n, tz) >= reminderDay({ periodEnd: pe, daysBefore, tz });
}

// Add whole months, clamping to the last day of shorter months (Jan 31 + 1 =
// Feb 28/29), the way Stripe anchors monthly billing. UTC-based.
function addMonths(date, months) {
  const d = toDate(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())
  );
}

/**
 * Whole months from `start` to `end` (default now): the number of monthly
 * anniversaries that have passed, month-end aware (Jan 31 → Feb 28 = 1).
 * 0 for missing start or end before start.
 * @returns {number}
 */
function monthsBetween(start, end = new Date()) {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e || Number.isNaN(s.getTime()) || e < s) return 0;
  let n = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (n > 0 && addMonths(s, n) > e) n -= 1;
  return Math.max(0, n);
}

/**
 * Does a card stop working before `date`? Cards are valid through the last
 * day of their expiry month.
 * @param {{expMonth: number, expYear: number}} card
 * @param {Date} date — usually billing.currentPeriodEnd
 * @returns {boolean} false when the expiry is unknown
 */
function cardExpiresBefore({ expMonth, expYear } = {}, date) {
  const m = Number(expMonth);
  const y = Number(expYear);
  const d = toDate(date);
  if (!m || !y || !d) return false;
  const firstInvalid = Date.UTC(y, m, 1); // 1st of the month after expiry
  return d.getTime() >= firstInvalid;
}

/**
 * One-time "set up your payment" nudge: due `days` days after signing while
 * the contract is still awaiting payment, and not sent before.
 * @returns {boolean}
 */
function isNudgeDue({ signedAt, now = new Date(), nudgeSentAt = null, days = 3 }) {
  if (nudgeSentAt || !signedAt) return false;
  return toDate(now).getTime() - toDate(signedAt).getTime() >= days * MS_DAY;
}

/**
 * "MM/YYYY" for a card expiry — the value stored in
 * reminders.lastCardExpiryNoticeFor so each card gets one notice. '' when unknown.
 */
function cardExpiryKey({ expMonth, expYear } = {}) {
  const m = Number(expMonth);
  const y = Number(expYear);
  if (!m || !y || m < 1 || m > 12) return '';
  return `${String(m).padStart(2, '0')}/${y}`;
}

// Fallback business hours when no send window is configured at all.
const FALLBACK_START_HOUR = 9;
const FALLBACK_END_HOUR = 18;

/**
 * May the payment reminder worker email homeowners right now? Inside the
 * Settings send window for today (sendWindow.isWithinSendWindow); with no
 * windows configured (or every day switched off, which would otherwise stop
 * payment emails for good) it falls back to 9:00–18:00 in tz.
 * @returns {boolean}
 */
function isWithinReminderHours({ sendWindows, now = new Date(), tz = DEFAULT_TIMEZONE }) {
  const sw = sendWindows && typeof sendWindows.toObject === 'function' ? sendWindows.toObject() : sendWindows;
  const anyEnabled = sw && Object.values(sw).some((w) => w && w.enabled);
  if (anyEnabled) return isWithinSendWindow(sw, toDate(now), tz);
  const p = zonedParts(toDate(now), tz);
  return p.hour >= FALLBACK_START_HOUR && p.hour < FALLBACK_END_HOUR;
}

module.exports = {
  reminderDay,
  isReminderDue,
  addMonths,
  monthsBetween,
  cardExpiresBefore,
  cardExpiryKey,
  isNudgeDue,
  isWithinReminderHours,
};

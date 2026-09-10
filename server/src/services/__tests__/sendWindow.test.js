/**
 * Pure-function tests for the timezone-aware send window logic.
 * No DB or network — run with: npm run test:sendwindow  (from server/)
 *
 * The bug these lock in: windows used to be evaluated with the SERVER's clock,
 * so "09:00" on a box in another zone showed up as 12:00 (or 5:00) for the
 * owner. Every expectation below is stated as an absolute UTC instant so the
 * suite passes no matter what TZ the test runner uses.
 */
const assert = require('assert');
const {
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
} = require('../sendWindow');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TZ = 'America/Toronto'; // EDT (UTC-4) in September, EST (UTC-5) in winter
const win = (enabled, start = '09:00', end = '21:00') => ({ enabled, start, end });
const WEEKDAYS = {
  monday: win(true),
  tuesday: win(true),
  wednesday: win(true),
  thursday: win(true),
  friday: win(true),
  saturday: win(true, '10:00', '18:00'),
  sunday: win(false),
};
const iso = (d) => (d ? d.toISOString() : d);

console.log('isValidTimezone / resolveScheduleTimezone');
t('accepts IANA names, rejects junk', () => {
  assert.strictEqual(isValidTimezone('America/Toronto'), true);
  assert.strictEqual(isValidTimezone('UTC'), true);
  assert.strictEqual(isValidTimezone('Mars/Olympus'), false);
  assert.strictEqual(isValidTimezone(''), false);
  assert.strictEqual(isValidTimezone(null), false);
});
t('schedule timezone wins, then Aria, then Eastern', () => {
  assert.strictEqual(resolveScheduleTimezone({ schedule: { timezone: 'Europe/London' }, aria: { timezone: 'Asia/Karachi' } }), 'Europe/London');
  assert.strictEqual(resolveScheduleTimezone({ schedule: {}, aria: { timezone: 'Asia/Karachi' } }), 'Asia/Karachi');
  assert.strictEqual(resolveScheduleTimezone({}), 'America/New_York');
  assert.strictEqual(resolveScheduleTimezone({ schedule: { timezone: 'Nope/Nope' } }), 'America/New_York');
});

console.log('parseHM');
t('parses HH:MM, rejects garbage', () => {
  assert.strictEqual(parseHM('09:30'), 570);
  assert.strictEqual(parseHM('00:00'), 0);
  assert.strictEqual(parseHM('24:00'), null);
  assert.strictEqual(parseHM('abc'), null);
  assert.strictEqual(parseHM(''), null);
});

console.log('zonedParts / zonedTimeToUtc (the core conversion)');
t('reads the wall clock in the zone, not the server clock', () => {
  const p = zonedParts(new Date('2026-09-10T13:00:00Z'), TZ); // 9:00 AM EDT
  assert.deepStrictEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 9, 10, 9, 0, 4]);
});
t('midnight comes back as hour 0, not 24', () => {
  const p = zonedParts(new Date('2026-09-10T04:00:00Z'), TZ); // 00:00 EDT
  assert.strictEqual(p.hour, 0);
  assert.strictEqual(p.day, 10);
});
t('9:00 AM Toronto in September is 13:00Z; in January it is 14:00Z', () => {
  assert.strictEqual(iso(zonedTimeToUtc({ year: 2026, month: 9, day: 10, hour: 9 }, TZ)), '2026-09-10T13:00:00.000Z');
  assert.strictEqual(iso(zonedTimeToUtc({ year: 2026, month: 1, day: 12, hour: 9 }, TZ)), '2026-01-12T14:00:00.000Z');
});
t('round-trips through zonedParts', () => {
  const inst = zonedTimeToUtc({ year: 2026, month: 11, day: 20, hour: 21, minute: 15 }, 'Asia/Karachi');
  const p = zonedParts(inst, 'Asia/Karachi');
  assert.deepStrictEqual([p.hour, p.minute, p.day], [21, 15, 20]);
});
t('spring-forward gap resolves to the later (existing) instant', () => {
  // 2026-03-08 02:30 does not exist in Toronto; expect 03:30 EDT = 07:30Z.
  assert.strictEqual(iso(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, TZ)), '2026-03-08T07:30:00.000Z');
});
t('startOfDayInTimezone', () => {
  assert.strictEqual(iso(startOfDayInTimezone(new Date('2026-09-10T02:00:00Z'), TZ)), '2026-09-09T04:00:00.000Z'); // still Sep 9 in Toronto
  assert.strictEqual(iso(startOfDayInTimezone(new Date('2026-09-10T13:00:00Z'), TZ)), '2026-09-10T04:00:00.000Z');
});

console.log('isWithinSendWindow');
t('8:59 AM Toronto is closed, 9:00 AM is open, 9:00 PM is closed again', () => {
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, new Date('2026-09-10T12:59:00Z'), TZ), false);
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, new Date('2026-09-10T13:00:00Z'), TZ), true);
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, new Date('2026-09-11T01:00:00Z'), TZ), false); // 9 PM Thu
});
t('the same instant is judged by the configured zone, not UTC', () => {
  const at = new Date('2026-09-10T10:00:00Z'); // 6 AM Toronto, 10 AM London
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, at, TZ), false);
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, at, 'Europe/London'), true);
});
t('disabled day is closed all day; missing config is open', () => {
  assert.strictEqual(isWithinSendWindow(WEEKDAYS, new Date('2026-09-13T16:00:00Z'), TZ), false); // Sunday noon
  assert.strictEqual(isWithinSendWindow(null, new Date('2026-09-13T16:00:00Z'), TZ), true);
});
t('wrap-around window (22:00 → 02:00)', () => {
  const night = { thursday: win(true, '22:00', '02:00'), friday: win(true, '22:00', '02:00') };
  assert.strictEqual(isWithinSendWindow(night, new Date('2026-09-11T03:00:00Z'), TZ), true); // 11 PM Thu
  assert.strictEqual(isWithinSendWindow(night, new Date('2026-09-11T05:30:00Z'), TZ), true); // 1:30 AM Fri
  assert.strictEqual(isWithinSendWindow(night, new Date('2026-09-11T15:00:00Z'), TZ), false); // 11 AM Fri
});

console.log('nextSendOpening');
t('returns `from` unchanged when already open', () => {
  const from = new Date('2026-09-10T15:00:00Z');
  assert.strictEqual(nextSendOpening(WEEKDAYS, from, TZ), from);
});
t('queued at 10 PM Thursday → opens 9:00 AM Friday Toronto (13:00Z), NOT 9:00 UTC', () => {
  const from = new Date('2026-09-11T02:00:00Z'); // 10 PM Thu EDT
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, from, TZ)), '2026-09-11T13:00:00.000Z');
});
t('queued before the window on the same day → today at 9:00 AM', () => {
  const from = new Date('2026-09-10T09:30:00Z'); // 5:30 AM Thu EDT
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, from, TZ)), '2026-09-10T13:00:00.000Z');
});
t('Saturday evening skips the disabled Sunday and lands on Monday 9:00 AM', () => {
  const from = new Date('2026-09-13T00:00:00Z'); // Sat 8 PM EDT
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, from, TZ)), '2026-09-14T13:00:00.000Z');
});
t('Saturday uses its own later start (10:00)', () => {
  const from = new Date('2026-09-12T05:00:00Z'); // Sat 1 AM EDT
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, from, TZ)), '2026-09-12T14:00:00.000Z');
});
t('a window on a single weekday still resolves (scans 14 days)', () => {
  const onlyMonday = { monday: win(true) };
  const from = new Date('2026-09-15T13:30:00Z'); // Tue 9:30 AM
  assert.strictEqual(iso(nextSendOpening(onlyMonday, from, TZ)), '2026-09-21T13:00:00.000Z');
});
t('every day disabled → null', () => {
  const none = { monday: win(false) };
  assert.strictEqual(nextSendOpening(none, new Date('2026-09-10T15:00:00Z'), TZ), null);
});
t('crosses DST correctly: Friday before fall-back opens at 13:00Z, Monday after at 14:00Z', () => {
  const fri = new Date('2026-10-30T02:00:00Z'); // Thu 10 PM EDT
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, fri, TZ)), '2026-10-30T13:00:00.000Z');
  const mon = new Date('2026-11-01T02:00:00Z'); // Sat 10 PM EDT; Sunday off; DST ends Nov 1
  assert.strictEqual(iso(nextSendOpening(WEEKDAYS, mon, TZ)), '2026-11-02T14:00:00.000Z');
});

console.log('currentWindowEnd / windowStatus');
t('inside the window → closes at 9:00 PM Toronto (01:00Z)', () => {
  assert.strictEqual(iso(currentWindowEnd(WEEKDAYS, new Date('2026-09-10T15:00:00Z'), TZ)), '2026-09-11T01:00:00.000Z');
  assert.strictEqual(currentWindowEnd(WEEKDAYS, new Date('2026-09-10T09:00:00Z'), TZ), null);
});
t('windowStatus summarises open/closed + next opening', () => {
  const open = windowStatus(WEEKDAYS, new Date('2026-09-10T15:00:00Z'), TZ);
  assert.strictEqual(open.open, true);
  assert.strictEqual(open.closesAt, '2026-09-11T01:00:00.000Z');
  assert.strictEqual(open.nextOpening, null);
  assert.strictEqual(open.timezone, TZ);
  assert.strictEqual(open.today.dayKey, 'thursday');
  const closed = windowStatus(WEEKDAYS, new Date('2026-09-11T02:00:00Z'), TZ);
  assert.strictEqual(closed.open, false);
  assert.strictEqual(closed.nextOpening, '2026-09-11T13:00:00.000Z');
  assert.deepStrictEqual(closed.enabledDays, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
});

console.log('previewWindows');
t('7-day preview starts on the zone-local date and carries exact instants', () => {
  const rows = previewWindows(WEEKDAYS, new Date('2026-09-11T02:00:00Z'), 7, TZ); // Thu 10 PM EDT
  assert.strictEqual(rows.length, 7);
  assert.strictEqual(rows[0].date, '2026-09-10');
  assert.strictEqual(rows[0].dayKey, 'thursday');
  assert.strictEqual(rows[0].opensAt, '2026-09-10T13:00:00.000Z');
  assert.strictEqual(rows[3].dayKey, 'sunday');
  assert.strictEqual(rows[3].enabled, false);
  assert.strictEqual(rows[3].opensAt, null);
});

console.log('formatInTimezone');
t('renders in the zone with its abbreviation', () => {
  const s = formatInTimezone(new Date('2026-09-10T13:00:00Z'), TZ);
  assert.ok(s.includes('9:00 AM'), s);
  assert.ok(s.includes('EDT'), s);
});

console.log(`\nAll ${passed} assertions passed ✅`);

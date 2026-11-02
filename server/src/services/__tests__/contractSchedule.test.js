const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const s = require('../contracts/schedule');
const { dueActions } = require('../../workers/paymentReminderWorker');

// Billing calendar helpers (pure) and the reminder worker's per-contract
// decision. Toronto DST 2026: starts Sun Mar 8, ends Sun Nov 1.

const TZ = 'America/Toronto';
const D = (iso) => new Date(iso);

group('isReminderDue');
t('3 days before, by Toronto calendar day', () => {
  const periodEnd = D('2026-06-10T13:00:00Z'); // Jun 10 09:00 EDT
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-07T03:59:00Z'), tz: TZ }), false); // Jun 6 23:59
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-07T04:00:00Z'), tz: TZ }), true); // Jun 7 00:00
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-10T12:59:00Z'), tz: TZ }), true);
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-10T13:00:00Z'), tz: TZ }), false, 'charge already happened');
});
t('across the fall-back DST change (Nov 1)', () => {
  const periodEnd = D('2026-11-03T14:00:00Z'); // Nov 3 09:00 EST
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-10-31T03:30:00Z'), tz: TZ }), false); // Oct 30 23:30 EDT
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-10-31T04:30:00Z'), tz: TZ }), true); // Oct 31 00:30 EDT
});
t('across the spring-forward DST change (Mar 8)', () => {
  const periodEnd = D('2026-03-10T13:00:00Z'); // Mar 10 09:00 EDT
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-03-07T04:30:00Z'), tz: TZ }), false); // Mar 6 23:30 EST
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-03-07T05:30:00Z'), tz: TZ }), true); // Mar 7 00:30 EST
});
t('a late-evening UTC charge counts the Toronto date, not the UTC date', () => {
  // Charge at 02:00 UTC Jun 10 = Jun 9 22:00 EDT → reminder day is Jun 6.
  const periodEnd = D('2026-06-10T02:00:00Z');
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-06T14:00:00Z'), tz: TZ }), true);
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now: D('2026-06-06T14:00:00Z'), tz: 'UTC' }), false);
});
t('one reminder per period (lastRemindedPeriodEnd)', () => {
  const periodEnd = D('2026-06-10T13:00:00Z');
  const now = D('2026-06-08T15:00:00Z');
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now, tz: TZ, lastRemindedPeriodEnd: D('2026-05-10T13:00:00Z') }), true);
  assert.strictEqual(s.isReminderDue({ periodEnd, daysBefore: 3, now, tz: TZ, lastRemindedPeriodEnd: '2026-06-10T13:00:00.000Z' }), false);
});
t('missing / invalid period end is never due', () => {
  assert.strictEqual(s.isReminderDue({ periodEnd: null, now: D('2026-06-08T15:00:00Z'), tz: TZ }), false);
  assert.strictEqual(s.isReminderDue({ periodEnd: 'garbage', now: D('2026-06-08T15:00:00Z'), tz: TZ }), false);
});

group('months');
t('addMonths clamps to month end (Jan 31 anchor)', () => {
  assert.strictEqual(s.addMonths(D('2026-01-31T15:00:00Z'), 1).toISOString(), '2026-02-28T15:00:00.000Z');
  assert.strictEqual(s.addMonths(D('2028-01-31T15:00:00Z'), 1).toISOString(), '2028-02-29T15:00:00.000Z');
  assert.strictEqual(s.addMonths(D('2026-01-31T15:00:00Z'), 3).toISOString(), '2026-04-30T15:00:00.000Z');
  assert.strictEqual(s.addMonths(D('2026-11-15T15:00:00Z'), 2).toISOString(), '2027-01-15T15:00:00.000Z');
});
t('monthsBetween counts monthly anniversaries', () => {
  const start = D('2026-01-31T15:00:00Z');
  assert.strictEqual(s.monthsBetween(start, D('2026-02-27T15:00:00Z')), 0);
  assert.strictEqual(s.monthsBetween(start, D('2026-02-28T15:00:00Z')), 1);
  assert.strictEqual(s.monthsBetween(start, D('2026-03-30T15:00:00Z')), 1);
  assert.strictEqual(s.monthsBetween(start, D('2026-03-31T15:00:00Z')), 2);
  assert.strictEqual(s.monthsBetween(D('2026-03-03T15:00:00Z'), D('2027-03-03T15:00:00Z')), 12);
  assert.strictEqual(s.monthsBetween(null, D('2026-03-31T15:00:00Z')), 0);
  assert.strictEqual(s.monthsBetween(D('2026-05-01T00:00:00Z'), D('2026-04-01T00:00:00Z')), 0);
});

group('cards + nudge');
t('cardExpiresBefore: valid through the last day of the expiry month', () => {
  const card = { expMonth: 11, expYear: 2026 };
  assert.strictEqual(s.cardExpiresBefore(card, D('2026-11-30T23:00:00Z')), false);
  assert.strictEqual(s.cardExpiresBefore(card, D('2026-12-01T00:00:00Z')), true);
  assert.strictEqual(s.cardExpiresBefore({ expMonth: 12, expYear: 2026 }, D('2027-01-03T00:00:00Z')), true);
  assert.strictEqual(s.cardExpiresBefore({}, D('2027-01-03T00:00:00Z')), false);
});
t('cardExpiryKey is MM/YYYY', () => {
  assert.strictEqual(s.cardExpiryKey({ expMonth: 3, expYear: 2027 }), '03/2027');
  assert.strictEqual(s.cardExpiryKey({ expMonth: 13, expYear: 2027 }), '');
  assert.strictEqual(s.cardExpiryKey({}), '');
});
t('isNudgeDue: 3 days after signing, once', () => {
  const signedAt = D('2026-06-01T15:00:00Z');
  assert.strictEqual(s.isNudgeDue({ signedAt, now: D('2026-06-04T14:59:00Z') }), false);
  assert.strictEqual(s.isNudgeDue({ signedAt, now: D('2026-06-04T15:00:00Z') }), true);
  assert.strictEqual(s.isNudgeDue({ signedAt, now: D('2026-06-09T15:00:00Z'), nudgeSentAt: D('2026-06-05T15:00:00Z') }), false);
  assert.strictEqual(s.isNudgeDue({ signedAt: null, now: D('2026-06-09T15:00:00Z') }), false);
});

group('reminder hours');
const weekdays = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 };
const windows = Object.fromEntries(
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, { enabled: Boolean(weekdays[d]), start: '09:00', end: '17:00' }])
);
t('inside / outside the configured send window', () => {
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: windows, now: D('2026-06-10T14:00:00Z'), tz: TZ }), true); // Wed 10:00
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: windows, now: D('2026-06-10T22:00:00Z'), tz: TZ }), false); // Wed 18:00
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: windows, now: D('2026-06-13T14:00:00Z'), tz: TZ }), false); // Sat
});
t('no window configured → 9:00–18:00 fallback', () => {
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: null, now: D('2026-06-13T14:00:00Z'), tz: TZ }), true); // Sat 10:00
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: null, now: D('2026-06-13T23:00:00Z'), tz: TZ }), false); // 19:00
  const allOff = Object.fromEntries(Object.keys(windows).map((d) => [d, { enabled: false, start: '09:00', end: '17:00' }]));
  assert.strictEqual(s.isWithinReminderHours({ sendWindows: allOff, now: D('2026-06-10T14:00:00Z'), tz: TZ }), true);
});

group('worker: dueActions');
const base = {
  status: 'active',
  billing: { currentPeriodEnd: D('2026-06-10T13:00:00Z'), pmExpMonth: 12, pmExpYear: 2027, cancelAtPeriodEnd: false },
  reminders: { enabled: true, lastRemindedPeriodEnd: null, lastCardExpiryNoticeFor: '' },
};
const opts = { now: D('2026-06-08T15:00:00Z'), tz: TZ, daysBefore: 3, remindersOn: true };
t('active → upcoming payment reminder for the period', () => {
  const r = dueActions(base, opts);
  assert.strictEqual(r.reminder, 'upcoming_payment');
  assert.strictEqual(r.periodEnd.toISOString(), '2026-06-10T13:00:00.000Z');
  assert.strictEqual(r.cardNotice, null);
});
t('past_due → failed-payment email instead', () => {
  assert.strictEqual(dueActions({ ...base, status: 'past_due' }, opts).reminder, 'payment_failed');
});
t('toggles: global off, contract off, cancelling at period end', () => {
  assert.strictEqual(dueActions(base, { ...opts, remindersOn: false }).reminder, null);
  assert.strictEqual(dueActions({ ...base, reminders: { enabled: false } }, opts).reminder, null);
  assert.strictEqual(dueActions({ ...base, billing: { ...base.billing, cancelAtPeriodEnd: true } }, opts).reminder, null);
});
t('card expiring before the next charge → once per expiry', () => {
  const c = { ...base, billing: { ...base.billing, pmExpMonth: 5, pmExpYear: 2026 } };
  assert.strictEqual(dueActions(c, opts).cardNotice, '05/2026');
  assert.strictEqual(dueActions({ ...c, reminders: { ...c.reminders, lastCardExpiryNoticeFor: '05/2026' } }, opts).cardNotice, null);
});
t('nudge only for invited, awaiting-payment contracts without a package problem', () => {
  const c = { status: 'awaiting_payment', signedAt: D('2026-06-01T15:00:00Z'), portal: { invitedAt: D('2026-06-01T15:00:00Z') }, needsAttention: '' };
  assert.strictEqual(dueActions(c, opts).nudge, true);
  assert.strictEqual(dueActions({ ...c, paymentSetupNudgeSentAt: D('2026-06-05T00:00:00Z') }, opts).nudge, false);
  assert.strictEqual(dueActions({ ...c, needsAttention: 'package_missing' }, opts).nudge, false);
  assert.strictEqual(dueActions({ ...c, portal: { invitedAt: null } }, opts).nudge, false);
  assert.strictEqual(dueActions({ ...c, status: 'active' }, opts).nudge, false);
});

module.exports = done();

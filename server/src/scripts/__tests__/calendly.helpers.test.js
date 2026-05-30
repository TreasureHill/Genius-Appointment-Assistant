/**
 * Pure-function tests for the Calendly matching/decision helpers.
 * No DB or network — run with: npm run test:calendly  (from server/)
 *
 * These lock in the fixes for the two big "auto appointment check" bugs:
 *   1. Past events (Calendly still reports status=active) must resolve to
 *      'completed', not bounce a finished lot back to 'scheduled'.
 *   2. Opted-out lots are never overridden.
 */
const assert = require('assert');
const {
  normalizeEmail,
  eventHasEnded,
  reconcileTargetStatus,
  findLotHits,
  buildLotCalendlyEvent,
} = require('../../services/calendly');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const HOUR = 3600 * 1000;
const now = Date.parse('2026-05-30T12:00:00Z');
const past = new Date(now - 48 * HOUR).toISOString();
const future = new Date(now + 48 * HOUR).toISOString();

console.log('normalizeEmail');
t('lowercases and trims', () => {
  assert.strictEqual(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
});
t('handles null/undefined', () => {
  assert.strictEqual(normalizeEmail(null), '');
  assert.strictEqual(normalizeEmail(undefined), '');
});

console.log('eventHasEnded');
t('past event (by end_time) has ended', () => {
  assert.strictEqual(eventHasEnded({ end_time: past }, now), true);
});
t('future event has not ended', () => {
  assert.strictEqual(eventHasEnded({ end_time: future }, now), false);
});
t('falls back to start_time when end_time missing', () => {
  assert.strictEqual(eventHasEnded({ start_time: past }, now), true);
  assert.strictEqual(eventHasEnded({ start_time: future }, now), false);
});
t('camelCase fields (stored Date) also work', () => {
  assert.strictEqual(eventHasEnded({ endTime: new Date(now - HOUR) }, now), true);
});
t('no time info → not ended (safe default)', () => {
  assert.strictEqual(eventHasEnded({}, now), false);
});

console.log('reconcileTargetStatus');
t('upcoming appointment → scheduled', () => {
  assert.strictEqual(reconcileTargetStatus('pending', { start_time: future }, now), 'scheduled');
  assert.strictEqual(reconcileTargetStatus('contacted', { end_time: future }, now), 'scheduled');
});
t('past appointment → completed (THE missed-appointment case)', () => {
  assert.strictEqual(reconcileTargetStatus('contacted', { end_time: past }, now), 'completed');
  assert.strictEqual(reconcileTargetStatus('scheduled', { start_time: past }, now), 'completed');
});
t('opted_out is never overridden', () => {
  assert.strictEqual(reconcileTargetStatus('opted_out', { start_time: future }, now), null);
  assert.strictEqual(reconcileTargetStatus('opted_out', { end_time: past }, now), null);
});
t('a completed lot with a future re-booking flips back to scheduled', () => {
  assert.strictEqual(reconcileTargetStatus('completed', { start_time: future }, now), 'scheduled');
});

console.log('findLotHits');
t('matches buyers across all roles, case-insensitively', () => {
  const occ = new Map([['jane@x.com', [{ eventUri: 'e1' }]]]);
  const lot = {
    buyers: [
      { role: 'buyer', email: 'NoMatch@x.com', name: 'A' },
      { role: 'coBuyer', email: 'JANE@x.com', name: 'Jane' },
    ],
  };
  const hits = findLotHits(lot, occ);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].role, 'coBuyer');
  assert.strictEqual(hits[0].email, 'jane@x.com');
});
t('no buyers / empty emails → no hits, no throw', () => {
  assert.deepStrictEqual(findLotHits({}, new Map()), []);
  assert.deepStrictEqual(findLotHits({ buyers: [{ role: 'buyer', email: '' }] }, new Map()), []);
});

console.log('buildLotCalendlyEvent');
t('maps occurrence + email/role into the lot subdocument shape', () => {
  const occ = {
    eventName: 'Walkthrough',
    startTime: future,
    endTime: null,
    inviteeName: 'Jane',
    inviteeStatus: 'active',
    location: 'Zoom',
    rescheduleUrl: 'r',
    cancelUrl: 'c',
  };
  const ev = buildLotCalendlyEvent(occ, 'jane@x.com', 'coBuyer');
  assert.strictEqual(ev.name, 'Walkthrough');
  assert.strictEqual(ev.inviteeEmail, 'jane@x.com');
  assert.strictEqual(ev.matchedBuyerRole, 'coBuyer');
  assert.ok(ev.startTime instanceof Date);
  assert.strictEqual(ev.endTime, null);
  assert.ok(ev.lastSyncedAt instanceof Date);
});

console.log(`\nAll ${passed} assertions passed ✅`);

/**
 * Pure-function tests for the Calendly availability lookup (no network — the
 * window fetcher is injected).
 * Run with: npm run test:availability  (from server/)
 *
 * These lock in the fix for "Aria's get_availability timed out on the first
 * try, then worked": the 7-day windows are now read CONCURRENTLY under a hard
 * time budget, and the result is cached, so the tool answers in seconds
 * instead of walking up to nine Calendly requests one after another.
 */
const assert = require('assert');
const {
  buildAvailabilityWindows,
  listAvailableTimes,
  clearAvailabilityCache,
} = require('../calendly');

let passed = 0;
function t(name, fn) {
  return fn().then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}
const sync = (name, fn) => t(name, async () => fn());

const NOW = Date.parse('2026-09-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const URI = 'https://api.calendly.com/event_types/abc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Calendly: `slotsByWindow(index)` decides what each window returns,
// every request takes `latency` ms, and calls are counted so we can prove the
// windows really are fetched in parallel.
function fakeCalendly({ latency = 100, slotsFor = () => [], failAll = false } = {}) {
  const state = { calls: 0, concurrentPeak: 0, inFlight: 0 };
  const fetchWindow = async (win) => {
    const index = Math.round((win.start.getTime() - (NOW + 2 * 60 * 1000)) / (7 * DAY));
    state.calls += 1;
    state.inFlight += 1;
    state.concurrentPeak = Math.max(state.concurrentPeak, state.inFlight);
    try {
      await sleep(latency);
      if (failAll) {
        const err = new Error('Calendly unavailable');
        err.response = { data: { message: 'Calendly unavailable' } };
        throw err;
      }
      return { collection: slotsFor(index) };
    } finally {
      state.inFlight -= 1;
    }
  };
  return { fetchWindow, state };
}

const slot = (iso, status = 'available') => ({ start_time: iso, status, scheduling_url: 'https://x' });
const call = (opts, extra = {}) =>
  listAvailableTimes({
    eventTypeUri: URI,
    timeZone: 'America/Toronto',
    now: NOW,
    refresh: true,
    ...extra,
    fetchWindow: opts.fetchWindow,
  });

(async () => {
  console.log('buildAvailabilityWindows');
  await sync('chunks 60 days into <=7-day windows, chronological, starting in the future', () => {
    const w = buildAvailabilityWindows(60, NOW);
    assert.strictEqual(w.length, 9);
    assert.ok(w[0].start.getTime() > NOW, 'first window starts in the future');
    assert.ok(w[0].start.getTime() - NOW <= 3 * 60 * 1000);
    for (const win of w) assert.ok(win.end - win.start <= 7 * DAY + 1000);
    for (let i = 1; i < w.length; i++) {
      assert.strictEqual(w[i].start.getTime(), w[i - 1].end.getTime(), 'windows are contiguous');
    }
    assert.ok(w[w.length - 1].end.getTime() <= NOW + 60 * DAY + 1000);
  });
  await sync('a short horizon is a single window', () => {
    assert.strictEqual(buildAvailabilityWindows(5, NOW).length, 1);
  });

  console.log('listAvailableTimes — speed');
  await t('reads windows in parallel, not one after another (the timeout bug)', async () => {
    clearAvailabilityCache();
    // Nothing until the 5th week: sequentially that is 6 requests x 200 ms.
    const fake = fakeCalendly({
      latency: 200,
      slotsFor: (i) => (i >= 5 ? [slot('2026-10-20T15:00:00Z'), slot('2026-10-20T18:00:00Z')] : []),
    });
    const started = Date.now();
    const r = await call(fake, { limit: 2 });
    const elapsed = Date.now() - started;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.slots.length, 2);
    assert.ok(fake.state.concurrentPeak > 1, `windows fetched in parallel (peak ${fake.state.concurrentPeak})`);
    assert.ok(elapsed < 900, `finished fast (${elapsed} ms, sequential would be ~1200 ms)`);
  });

  await t('returns what it has when the time budget runs out instead of hanging', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 400, slotsFor: (i) => (i === 0 ? [slot('2026-09-12T14:00:00Z')] : []) });
    const started = Date.now();
    const r = await call(fake, { limit: 6, budgetMs: 900 });
    const elapsed = Date.now() - started;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.slots.length, 1, 'the one slot it found is still returned');
    assert.strictEqual(r.partial, true, 'flagged as a partial read');
    assert.ok(elapsed < 2000, `respected the budget (${elapsed} ms)`);
  });

  await t('stops early once it has the slots the caller asked for', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 20, slotsFor: () => [slot('2026-09-12T14:00:00Z'), slot('2026-09-12T15:00:00Z')] });
    const r = await call(fake, { limit: 2 });
    assert.strictEqual(r.slots.length, 2);
    assert.ok(fake.state.calls <= 3, `did not read all nine windows (${fake.state.calls})`);
  });

  console.log('listAvailableTimes — results');
  await t('soonest slots come first and unavailable ones are skipped', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({
      latency: 5,
      slotsFor: (i) => {
        if (i === 0) return [slot('2026-09-12T14:00:00Z'), slot('2026-09-13T14:00:00Z', 'booked')];
        if (i === 1) return [slot('2026-09-19T14:00:00Z')];
        return [];
      },
    });
    const r = await call(fake, { limit: 5 });
    assert.deepStrictEqual(r.slots.map((s) => s.startTime), ['2026-09-12T14:00:00Z', '2026-09-19T14:00:00Z']);
    assert.ok(r.slots[0].label.includes('10:00 AM'), r.slots[0].label);
    assert.ok(r.slots[0].label.includes('Sat'), r.slots[0].label);
  });

  await t('a failing calendar reports the error rather than pretending there are no times', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 5, failAll: true });
    const r = await call(fake, { limit: 3 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.slots.length, 0);
    assert.ok(/unavailable/i.test(r.message), r.message);
  });

  await t('one bad window does not lose the slots from the others', async () => {
    clearAvailabilityCache();
    let n = 0;
    const fetchWindow = async (win) => {
      n += 1;
      if (n === 1) throw new Error('flaky');
      return { collection: [slot('2026-09-19T14:00:00Z')] };
    };
    const r = await call({ fetchWindow }, { limit: 1 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.slots.length, 1);
  });

  console.log('listAvailableTimes — cache');
  await t('a repeat lookup is served from cache (so a retry is instant)', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 5, slotsFor: () => [slot('2026-09-12T14:00:00Z'), slot('2026-09-12T15:00:00Z')] });
    await call(fake, { limit: 2 });
    const callsAfterFirst = fake.state.calls;
    const second = await listAvailableTimes({
      eventTypeUri: URI,
      timeZone: 'America/Toronto',
      now: NOW,
      limit: 2,
      fetchWindow: fake.fetchWindow,
    });
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.slots.length, 2);
    assert.strictEqual(fake.state.calls, callsAfterFirst, 'no new Calendly requests');
  });

  await t('the cache is not used when it holds fewer slots than asked for', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 5, slotsFor: (i) => (i === 0 ? [slot('2026-09-12T14:00:00Z')] : []) });
    await call(fake, { limit: 1, days: 7 });
    const before = fake.state.calls;
    const second = await listAvailableTimes({
      eventTypeUri: URI,
      timeZone: 'America/Toronto',
      now: NOW,
      limit: 4,
      fetchWindow: fake.fetchWindow,
    });
    assert.ok(fake.state.calls > before, 'went back to Calendly');
    assert.ok(!second.cached);
  });

  await t('an exhausted horizon is cached even when it found nothing', async () => {
    clearAvailabilityCache();
    const fake = fakeCalendly({ latency: 2, slotsFor: () => [] });
    const first = await call(fake, { limit: 6, days: 14 });
    assert.strictEqual(first.slots.length, 0);
    assert.strictEqual(first.partial, false, 'the whole horizon was read');
    const before = fake.state.calls;
    const second = await listAvailableTimes({
      eventTypeUri: URI,
      timeZone: 'America/Toronto',
      now: NOW,
      limit: 6,
      days: 14,
      fetchWindow: fake.fetchWindow,
    });
    assert.strictEqual(second.cached, true);
    assert.strictEqual(fake.state.calls, before);
  });

  clearAvailabilityCache();
  console.log(`\nAll ${passed} assertions passed ✅`);
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e);
  process.exit(1);
});

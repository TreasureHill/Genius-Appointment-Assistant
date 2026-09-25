/**
 * Pure-function tests for the Reviews tab: the alias / Genius-term matcher,
 * manual-override precedence, the timezone-aware weekly window and stats,
 * the SerpApi field mapping + incremental stop, JSON import normalisation,
 * and a smoke test of the .pptx / .xlsx builders.
 * No DB or network — run with: npm run test:reviews  (from server/)
 */
const assert = require('assert');
const { compileMatchers, classifyText, effective } = require('../reviews/classify');
const { resolveWindow, computeStats, formatRange } = require('../reviews/stats');
const serpapi = require('../reviews/serpapi');
const { normalizeImported } = require('../reviews/sync');
const { buildDeck, truncate, lines } = require('../reviews/deck');
const { buildWorkbook } = require('../reviews/excel');

let passed = 0;
const pending = [];
function t(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') {
    pending.push(
      r.then(() => {
        passed += 1;
        console.log(`  ✓ ${name}`);
      })
    );
    return;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const REPS = [
  { _id: 'r1', name: 'Jason', aliases: ['jason', 'jeson'] },
  { _id: 'r2', name: 'Salman', aliases: ['salman', 'syed', 'syed salman'] },
  { _id: 'r3', name: 'Alvee', aliases: ['alvee', 'alvi', 'alvy'] },
  { _id: 'r4', name: 'Gone', aliases: ['gone'], active: false },
];
const TERMS = ['genius', 'genious'];
const M = compileMatchers({ reps: REPS, geniusTerms: TERMS });

console.log('classify');
t('whole-word, case-insensitive matching', () => {
  const c = classifyText('JASON from Genius fixed it. Jasonville is a town.', M);
  assert.deepStrictEqual(c.reps, ['r1']);
  assert.deepStrictEqual(c.aliases, ['jason']);
  assert.deepStrictEqual(c.terms, ['genius']);
  assert.strictEqual(c.termHit, true);
  assert.strictEqual(c.genius, true);
});
t('several reps and aliases in one review', () => {
  const c = classifyText('Thanks a lot Jason and Syed. Alvi helped too.', M);
  assert.deepStrictEqual(c.reps, ['r1', 'r2', 'r3']);
  assert.strictEqual(c.termHit, false);
  assert.strictEqual(c.genius, true);
});
t('multi-word alias matches across any whitespace', () => {
  const c = classifyText('Installed by Syed\n Salman, great job', M);
  assert.deepStrictEqual(c.reps, ['r2']);
  assert.ok(c.aliases.includes('syed salman'));
});
t("possessives and punctuation still match ('Jason's', 'Alvee!')", () => {
  assert.deepStrictEqual(classifyText("Jason's work was great. Alvee!", M).reps, ['r1', 'r3']);
});
t('inactive reps never match; unrelated review is not Genius', () => {
  const c = classifyText('Gone did it. Tony and Ida made the Tarion process easy.', M);
  assert.deepStrictEqual(c.reps, []);
  assert.strictEqual(c.genius, false);
});
t('misspelled Genius term counts, name inside another word does not', () => {
  const c = classifyText('The genious package. Salmandra.', M);
  assert.deepStrictEqual(c.reps, []);
  assert.strictEqual(c.genius, true);
});
t('regex-special characters in aliases are escaped', () => {
  const m = compileMatchers({ reps: [{ _id: 'x', name: 'A.J.', aliases: ['a.j.'] }], geniusTerms: [] });
  assert.deepStrictEqual(classifyText('A.J. was here', m).reps, ['x']);
  assert.deepStrictEqual(classifyText('AXJX was here', m).reps, []);
});
t('hint words flag an untagged smart-home review as "possibly Genius" without tagging it', () => {
  const m = compileMatchers({ reps: REPS, geniusTerms: TERMS, hintTerms: ['google home', 'cameras', 'wifi'] });
  const c = classifyText('Amazing job setting up google home, remote garage opening and Sonos speakers.', m);
  assert.strictEqual(c.genius, false);
  assert.strictEqual(c.hint, true);
  assert.deepStrictEqual(c.hints, ['google home']);
  // A tagged review can carry hints too; the page only shows the badge when it is NOT Genius.
  const g = classifyText('Jason set up our cameras and wifi.', m);
  assert.strictEqual(g.genius, true);
  assert.deepStrictEqual(g.hints, ['cameras', 'wifi']);
  assert.strictEqual(classifyText('Great house, no issues.', m).hint, false);
  assert.strictEqual(classifyText('x', compileMatchers({ reps: REPS, geniusTerms: TERMS })).hint, false);
});
t('accented / unicode word boundaries', () => {
  const m = compileMatchers({ reps: [{ _id: 'j', name: 'José', aliases: [] }], geniusTerms: [] });
  assert.deepStrictEqual(classifyText('Merci José!', m).reps, ['j']);
  assert.deepStrictEqual(classifyText('Joséphine', m).reps, []);
});

console.log('effective mapping');
t('no override → auto', () => {
  const e = effective({ reps: ['r1'], termHit: false }, { repsSet: false, reps: [], genius: null });
  assert.deepStrictEqual(e, { reps: ['r1'], genius: true, mappingSource: 'auto' });
});
t('manual reps replace auto reps and make the review Genius-related', () => {
  const e = effective({ reps: [], termHit: false }, { repsSet: true, reps: ['r3'], genius: null });
  assert.deepStrictEqual(e, { reps: ['r3'], genius: true, mappingSource: 'manual' });
});
t('manual "nobody" clears reps; Genius then depends on the term hit', () => {
  assert.deepStrictEqual(effective({ reps: ['r1'], termHit: false }, { repsSet: true, reps: [], genius: null }), { reps: [], genius: false, mappingSource: 'manual' });
  assert.deepStrictEqual(effective({ reps: ['r1'], termHit: true }, { repsSet: true, reps: [], genius: null }), { reps: [], genius: true, mappingSource: 'manual' });
});
t('forced Genius flag wins both ways', () => {
  assert.strictEqual(effective({ reps: ['r1'], termHit: true }, { repsSet: false, genius: false }).genius, false);
  assert.strictEqual(effective({ reps: [], termHit: false }, { repsSet: false, genius: true }).genius, true);
  assert.strictEqual(effective({ reps: [], termHit: false }, { repsSet: false, genius: true }).mappingSource, 'manual');
});
t('missing manual block behaves like no override', () => {
  assert.deepStrictEqual(effective({ reps: ['r2'], termHit: true }, undefined), { reps: ['r2'], genius: true, mappingSource: 'auto' });
});

console.log('window');
const TZ = 'America/Toronto';
// Thu Sep 24 2026 23:30 EDT = Fri Sep 25 03:30 UTC — the local date must win.
const NOW = new Date('2026-09-25T03:30:00Z');
t('default window is Monday of the current week through today, in the schedule zone', () => {
  const w = resolveWindow({ tz: TZ, now: NOW });
  assert.strictEqual(w.start, '2026-09-21');
  assert.strictEqual(w.end, '2026-09-24');
  assert.strictEqual(w.startAt.toISOString(), '2026-09-21T04:00:00.000Z'); // midnight EDT
  assert.strictEqual(w.endAt.toISOString(), '2026-09-25T04:00:00.000Z'); // exclusive: midnight after today
  assert.strictEqual(w.isCurrentWeek, true);
  assert.strictEqual(w.label, 'September 21 – 24, 2026');
});
t('previous week runs Monday–Sunday; next week is capped at today', () => {
  const w = resolveWindow({ tz: TZ, now: NOW });
  assert.deepStrictEqual(w.prev, { start: '2026-09-14', end: '2026-09-20' });
  assert.strictEqual(w.next, null);
  const back = resolveWindow({ tz: TZ, now: NOW, start: '2026-09-14', end: '2026-09-20' });
  assert.deepStrictEqual(back.next, { start: '2026-09-21', end: '2026-09-24' });
  assert.strictEqual(back.isCurrentWeek, false);
});
t('explicit start only → that Monday-week (capped at today); swapped dates are fixed', () => {
  assert.deepStrictEqual([resolveWindow({ tz: TZ, now: NOW, start: '2026-09-07' }).start, resolveWindow({ tz: TZ, now: NOW, start: '2026-09-07' }).end], ['2026-09-07', '2026-09-13']);
  const sw = resolveWindow({ tz: TZ, now: NOW, start: '2026-09-18', end: '2026-09-14' });
  assert.deepStrictEqual([sw.start, sw.end], ['2026-09-14', '2026-09-18']);
  assert.strictEqual(resolveWindow({ tz: TZ, now: NOW, start: 'garbage' }).start, '2026-09-21');
});
t('range labels across months and years', () => {
  assert.strictEqual(formatRange('2026-08-31', '2026-09-06'), 'August 31 – September 6, 2026');
  assert.strictEqual(formatRange('2025-12-29', '2026-01-04'), 'December 29, 2025 – January 4, 2026');
  assert.strictEqual(formatRange('2026-09-14', '2026-09-14'), 'September 14, 2026');
});

console.log('stats');
const R = (id, { rating = 5, at, reps = [], genius = reps.length > 0, text = 'x', reply = '', manual = false } = {}) => ({
  _id: id,
  reviewer: id,
  rating,
  text,
  effectiveAt: new Date(at),
  postedAt: new Date(at),
  editedAt: new Date(at),
  reps,
  genius,
  reply: { text: reply },
  mappingSource: manual ? 'manual' : 'auto',
});
const REVIEWS = [
  R('a', { at: '2026-09-21T14:00:00Z', reps: ['r1'], text: 'Jason was amazing, long text here' }),
  R('b', { at: '2026-09-22T14:00:00Z', reps: ['r1', 'r2'], text: 'short' }),
  R('c', { at: '2026-09-23T14:00:00Z', rating: 4, reps: [], genius: true }), // Genius term only → unmapped
  R('d', { at: '2026-09-24T14:00:00Z', rating: 2, reps: [], genius: false, reply: 'sorry' }), // other, low, replied
  R('e', { at: '2026-09-25T03:59:00Z', reps: ['r3'] }), // Sep 24 23:59 EDT → still in window
  R('f', { at: '2026-09-25T04:00:00Z', reps: ['r3'] }), // Sep 25 00:00 EDT → outside (after today)
  R('g', { at: '2026-09-15T14:00:00Z', reps: ['r1'], rating: 4 }), // previous week
  R('h', { at: '2026-07-01T14:00:00Z', reps: [], genius: false }), // long ago, other
];
const REP_DOCS = [
  { _id: 'r1', name: 'Jason', color: '#111111', sortOrder: 0 },
  { _id: 'r2', name: 'Salman', sortOrder: 1 },
  { _id: 'r3', name: 'Alvee', sortOrder: 2 },
  { _id: 'r4', name: 'Gone', active: false },
];
const S = computeStats({ reviews: REVIEWS, reps: REP_DOCS, tz: TZ, now: NOW });
t('week counts use the local window end (exclusive)', () => {
  assert.strictEqual(S.week.total, 5);
  assert.strictEqual(S.week.hinted, 0);
  assert.strictEqual(S.week.genius, 4);
  assert.strictEqual(S.week.other, 1);
  assert.strictEqual(S.week.geniusFiveStar, 3);
  assert.strictEqual(S.week.lowRated, 1);
  assert.strictEqual(S.week.unreplied, 4);
  assert.strictEqual(S.week.unmapped, 1);
  assert.deepStrictEqual(S.week.ratings, [0, 1, 0, 1, 3]);
});
t('all-time totals and averages', () => {
  assert.strictEqual(S.allTime.total, 8);
  assert.strictEqual(S.allTime.genius, 6);
  assert.strictEqual(S.allTime.geniusAvgRating, 4.67);
});
t('per-rep rows: active only, sorted by week then all-time, with highlights', () => {
  assert.deepStrictEqual(S.reps.map((r) => r.name), ['Jason', 'Alvee', 'Salman']);
  const jason = S.reps[0];
  assert.strictEqual(jason.week, 2);
  assert.strictEqual(jason.allTime, 3);
  assert.strictEqual(jason.avgRating, 4.67);
  assert.strictEqual(jason.color, '#111111');
  assert.strictEqual(jason.highlights[0]._id, 'a'); // longest 5★ text first
  assert.strictEqual(S.reps[1].allTime, 2); // Alvee counts 'f' all-time but not this week
  assert.strictEqual(S.reps[1].week, 1);
});
t('trend ends with the selected week and buckets Mon–Sun', () => {
  assert.strictEqual(S.trend.length, 12);
  const last = S.trend[11];
  assert.strictEqual(last.start, '2026-09-21');
  assert.strictEqual(last.end, '2026-09-27');
  assert.strictEqual(last.current, true);
  assert.strictEqual(last.genius, 5); // includes 'f' (Sep 25), which is inside the Mon–Sun bucket
  assert.strictEqual(last.other, 1);
  assert.strictEqual(S.trend[10].genius, 1);
  assert.strictEqual(S.trend[10].start, '2026-09-14');
});
t('weekReviews is the window, newest first', () => {
  assert.deepStrictEqual(S.weekReviews.map((r) => r._id), ['e', 'd', 'c', 'b', 'a']);
});

console.log('serpapi');
const ITEM = {
  review_id: 'abc',
  link: 'https://maps.google.com/?cid=1',
  rating: 5,
  iso_date: '2026-09-14T15:10:00Z',
  iso_date_of_last_edit: '2026-09-16T10:00:00Z',
  snippet: 'One of the best service provided by Jason from Genius Package.',
  user: { name: 'Kaushal Patel', link: 'https://maps.google.com/u/1', thumbnail: 'https://img/1.png' },
  response: { snippet: 'Thank you!', iso_date: '2026-09-15T12:00:00Z' },
  likes: 2,
};
t('normalizeItem maps every field', () => {
  const r = serpapi.normalizeItem(ITEM);
  assert.strictEqual(r.reviewId, 'abc');
  assert.strictEqual(r.reviewer, 'Kaushal Patel');
  assert.strictEqual(r.rating, 5);
  assert.strictEqual(r.postedAt.toISOString(), '2026-09-14T15:10:00.000Z');
  assert.strictEqual(r.editedAt.toISOString(), '2026-09-16T10:00:00.000Z');
  assert.strictEqual(r.reply.text, 'Thank you!');
  assert.strictEqual(r.reply.at.toISOString(), '2026-09-15T12:00:00.000Z');
  assert.strictEqual(r.likes, 2);
  assert.strictEqual(r.source, 'serpapi');
});
t('normalizeItem: edit before post is clamped, missing fields fall back, no date → skipped', () => {
  const r = serpapi.normalizeItem({ iso_date: '2026-09-14T15:10:00Z', iso_date_of_last_edit: '2026-09-01T00:00:00Z', extracted_snippet: { original: 'txt' } });
  assert.strictEqual(r.editedAt.toISOString(), r.postedAt.toISOString());
  assert.strictEqual(r.text, 'txt');
  assert.strictEqual(r.reviewer, 'Anonymous');
  assert.strictEqual(r.reply.text, '');
  assert.ok(r.reviewId.startsWith('anonymous-'));
  assert.strictEqual(serpapi.normalizeItem({ snippet: 'no date' }), null);
});
function fakeHttp(pages) {
  const calls = [];
  return {
    calls,
    async get(url, { params }) {
      calls.push({ url, params });
      const idx = params.next_page_token ? Number(params.next_page_token.slice(1)) : 0;
      return { data: pages[idx] };
    },
  };
}
const day = (d) => `2026-09-${String(d).padStart(2, '0')}T12:00:00Z`;
// A five-review listing whose feed genuinely ends after three pages.
const PAGES = [
  {
    place_info: { title: 'Treasure Hill', address: '101 Bradwick Dr', rating: 4.4, reviews: 5 },
    reviews: [{ review_id: 'p0a', iso_date: day(20), rating: 5, snippet: 'a' }, { review_id: 'p0b', iso_date: day(18), rating: 4, snippet: 'b' }],
    serpapi_pagination: { next_page_token: 'T1' },
  },
  {
    reviews: [{ review_id: 'p1a', iso_date: day(16), rating: 5, snippet: 'c' }, { review_id: 'p1b', iso_date: day(10), rating: 5, snippet: 'd' }],
    serpapi_pagination: { next_page_token: 'T2' },
  },
  { reviews: [{ review_id: 'p2a', iso_date: day(5), rating: 5, snippet: 'e' }] },
];
t('a full read pages through the whole listing in "most relevant" order, no num on page 1', async () => {
  const http = fakeHttp(PAGES);
  const r = await serpapi.fetchReviews({ apiKey: 'k', placeId: 'P', http, pauseMs: 0 });
  assert.deepStrictEqual(r.reviews.map((x) => x.reviewId), ['p0a', 'p0b', 'p1a', 'p1b', 'p2a']);
  assert.strictEqual(r.searches, 3);
  assert.deepStrictEqual(r.meta, { title: 'Treasure Hill', address: '101 Bradwick Dr', rating: 4.4, total: 5 });
  assert.strictEqual(r.retries, 0);
  assert.strictEqual(http.calls[0].params.engine, 'google_maps_reviews');
  assert.strictEqual(http.calls[0].params.place_id, 'P');
  assert.strictEqual(http.calls[0].params.sort_by, 'qualityScore');
  assert.strictEqual(http.calls[0].params.next_page_token, undefined);
  assert.strictEqual(http.calls[0].params.num, undefined);
  assert.strictEqual(http.calls[1].params.next_page_token, 'T1');
  assert.strictEqual(http.calls[1].params.num, 20);
  assert.strictEqual(http.calls[1].params.sort_by, 'qualityScore');
  assert.strictEqual(r.exhausted, true);
  assert.strictEqual(r.reachedSince, false);
  assert.strictEqual(r.truncated, false);
});
t('an incremental read walks newest-first and stops at the first review older than `since`', async () => {
  const http = fakeHttp(PAGES);
  const r = await serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0, since: new Date(day(15)) });
  assert.deepStrictEqual(r.reviews.map((x) => x.reviewId), ['p0a', 'p0b', 'p1a']);
  assert.strictEqual(r.searches, 2);
  assert.strictEqual(http.calls[0].params.sort_by, 'newestFirst');
  assert.strictEqual(r.reachedSince, true);
  assert.strictEqual(r.exhausted, false);
});
t('the page token is also taken from the `next` URL when next_page_token is absent', async () => {
  const pages = [{ ...PAGES[0], serpapi_pagination: { next: 'https://serpapi.com/search.json?engine=google_maps_reviews&next_page_token=T1&api_key=k' } }, PAGES[1], PAGES[2]];
  const http = fakeHttp(pages);
  const r = await serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0 });
  assert.strictEqual(r.reviews.length, 5);
  assert.strictEqual(serpapi.nextTokenOf({ serpapi_pagination: { next: 'not a url' } }), null);
  assert.strictEqual(serpapi.nextTokenOf({}), null);
});
t('maxPages caps a runaway read and reports it', async () => {
  const http = fakeHttp(PAGES);
  const r = await serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0, maxPages: 1 });
  assert.strictEqual(r.reviews.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.exhausted, false);
});
t('readListing: full read = one pass in "most relevant" order', async () => {
  const http = fakeHttp(PAGES);
  const r = await serpapi.readListing({ apiKey: 'k', http, pauseMs: 0 });
  assert.strictEqual(r.full, true);
  assert.strictEqual(r.escalated, false);
  assert.strictEqual(r.reviews.length, 5);
  assert.ok(http.calls.every((c) => c.params.sort_by === 'qualityScore'));
});
t('readListing: incremental read that reaches `since` stays incremental', async () => {
  const http = fakeHttp(PAGES);
  const r = await serpapi.readListing({ apiKey: 'k', http, pauseMs: 0, since: new Date(day(15)) });
  assert.strictEqual(r.full, false);
  assert.strictEqual(r.escalated, false);
  assert.strictEqual(r.searches, 2);
  assert.deepStrictEqual(r.reviews.map((x) => x.reviewId), ['p0a', 'p0b', 'p1a']);
});
t('readListing: when the newest-first feed runs out before `since`, the whole listing is re-read', async () => {
  // Google's newest-first feed: only the two latest reviews, then no token.
  const newest = { place_info: PAGES[0].place_info, reviews: PAGES[0].reviews };
  const calls = [];
  const http = {
    calls,
    async get(url, { params }) {
      calls.push({ url, params });
      if (params.sort_by === 'newestFirst') return { data: newest };
      const idx = params.next_page_token ? Number(params.next_page_token.slice(1)) : 0;
      return { data: PAGES[idx] };
    },
  };
  const r = await serpapi.readListing({ apiKey: 'k', http, pauseMs: 0, since: new Date(day(1)) });
  assert.strictEqual(r.escalated, true);
  assert.strictEqual(r.full, true);
  // 1 newest-first page (+2 no_cache retries, since it ended at 2 of 5) + 3 "most relevant" pages
  assert.strictEqual(r.searches, 6);
  assert.strictEqual(r.retries, 2);
  assert.deepStrictEqual(r.reviews.map((x) => x.reviewId), ['p0a', 'p0b', 'p1a', 'p1b', 'p2a']);
  assert.strictEqual(r.meta.total, 5);
});
t('a page that ends the feed far below the listing total is re-fetched with no_cache, then accepted', async () => {
  // Same three pages, but the listing claims 770 reviews: page 3 (no token, 5 kept) looks like a cut-off.
  const big = PAGES.map((pg, i) => (i === 0 ? { ...pg, place_info: { ...pg.place_info, reviews: 770 } } : pg));
  const http = fakeHttp(big);
  const r = await serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0 });
  assert.strictEqual(r.reviews.length, 5);
  assert.strictEqual(r.retries, 2);
  assert.strictEqual(r.searches, 5); // 3 pages + 2 retries of the last one
  const last3 = http.calls.slice(-3).map((c) => c.params);
  assert.strictEqual(last3[0].no_cache, undefined);
  assert.strictEqual(last3[1].no_cache, true);
  assert.strictEqual(last3[2].no_cache, true);
  assert.ok(last3.every((p) => p.next_page_token === 'T2'));
  assert.strictEqual(r.exhausted, true);
});
t('a transient empty page recovers on retry and pagination continues', async () => {
  const big = PAGES.map((pg, i) => (i === 0 ? { ...pg, place_info: { ...pg.place_info, reviews: 770 } } : pg));
  let flaky = true;
  const http = {
    calls: [],
    async get(url, { params }) {
      http.calls.push({ url, params });
      const idx = params.next_page_token ? Number(params.next_page_token.slice(1)) : 0;
      if (idx === 1 && flaky) {
        flaky = false;
        return { data: { search_metadata: { status: 'Success' }, reviews: [] } }; // Google hiccup: empty, no token
      }
      return { data: big[idx] };
    },
  };
  const r = await serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0 });
  assert.deepStrictEqual(r.reviews.map((x) => x.reviewId), ['p0a', 'p0b', 'p1a', 'p1b', 'p2a']);
  assert.strictEqual(r.retries, 3); // one for the hiccup on page 2, two for the genuine end on page 3
  assert.strictEqual(http.calls[2].params.no_cache, true);
});
t('a SerpApi error mid-walk is retried, then surfaces if it persists', async () => {
  const pages = [PAGES[0], { error: 'Google hasn\'t returned any results for this query.' }];
  const http = fakeHttp(pages);
  await assert.rejects(() => serpapi.fetchReviews({ apiKey: 'k', http, pauseMs: 0 }), /hasn't returned any results/);
  assert.strictEqual(http.calls.length, 4); // page 1 + 3 attempts at page 2
});
t('SerpApi errors surface as errors (an unreadable listing is retried, then given up on)', async () => {
  const http = fakeHttp([{ error: 'Invalid API key.' }]);
  await assert.rejects(() => serpapi.fetchReviews({ apiKey: 'bad', http, pauseMs: 0 }), /Invalid API key/);
  assert.strictEqual(http.calls.length, 3);
  assert.strictEqual(serpapi.describeError({ response: { data: { error: 'nope' } } }), 'nope');
  assert.strictEqual(serpapi.describeError({ response: { status: 503 } }), 'SerpApi HTTP 503');
  assert.strictEqual(serpapi.describeError({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' }), 'SerpApi timed out');
});

console.log('sync bookkeeping');
const { completenessWarning } = require('../reviews/sync');
t('a full read that got far fewer reviews than the listing reports is flagged', () => {
  assert.ok(/25 of the listing's 770/.test(completenessWarning({ full: true, fetched: 25, total: 770 })));
  assert.strictEqual(completenessWarning({ full: true, fetched: 700, total: 770 }), '');
  assert.strictEqual(completenessWarning({ full: false, fetched: 3, total: 770 }), '');
  assert.strictEqual(completenessWarning({ full: true, fetched: 25, total: null }), '');
});

console.log('import');
t('normalizeImported accepts the Python fixture shape and our own', () => {
  const py = normalizeImported({ review_id: 'r004', reviewer: 'Chow Brian', rating: '5', created_at: '2026-09-01T20:00:00Z', updated_at: '2026-09-14T21:30:00Z', text: 'Alvee did a great job' });
  assert.strictEqual(py.reviewId, 'r004');
  assert.strictEqual(py.rating, 5);
  assert.strictEqual(py.editedAt.toISOString(), '2026-09-14T21:30:00.000Z');
  assert.strictEqual(py.source, 'import');
  const ours = normalizeImported({ reviewId: 'x', reviewer: 'A', rating: 9, postedAt: '2026-09-01T00:00:00Z', reply: { text: 'thanks', at: '2026-09-02T00:00:00Z' }, source: 'gbp' });
  assert.strictEqual(ours.rating, 5);
  assert.strictEqual(ours.editedAt.toISOString(), ours.postedAt.toISOString());
  assert.strictEqual(ours.reply.text, 'thanks');
  assert.strictEqual(ours.source, 'gbp');
  assert.strictEqual(normalizeImported({ reviewer: 'no date' }), null);
});

console.log('deck / excel');
t('truncate keeps whole words and adds an ellipsis; lines counts wrapped rows', () => {
  assert.strictEqual(truncate('one two three four', 100), 'one two three four');
  assert.strictEqual(truncate('one two three four', 10), 'one two…');
  assert.strictEqual(lines('a'.repeat(100) + '\n' + 'b', 40), 4);
});
t('buildDeck returns a .pptx (zip) with the expected slide count', async () => {
  const buf = await buildDeck({ stats: S, tz: TZ });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 10_000);
  assert.strictEqual(buf.slice(0, 2).toString(), 'PK');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  // cover + key metrics + highlights (3 reps → 1) + all-time (1) + review log (1)
  assert.strictEqual(slides.length, 5);
  const log = await zip.file('ppt/slides/slide5.xml').async('string');
  assert.ok(log.includes('Customer Review Log'));
  assert.ok(log.includes('Jason was amazing'));
});
t('buildWorkbook returns an .xlsx with four sheets', () => {
  const buf = buildWorkbook({ stats: S, allReviews: REVIEWS, reps: REP_DOCS, tz: TZ, listing: { total: 770, rating: 4.4 } });
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['Summary', 'Reps', 'Review log', 'All reviews']);
  const log = XLSX.utils.sheet_to_json(wb.Sheets['Review log']);
  assert.strictEqual(log.length, 5);
  assert.strictEqual(log[0].Reviewer, 'e');
  assert.strictEqual(log[4].Reps, 'Jason');
  assert.strictEqual(log[0]['Genius-related'], 'yes');
});

Promise.all(pending)
  .then(() => {
    console.log(`\n${passed} reviews tests passed`);
  })
  .catch((err) => {
    console.error('\n✗ reviews test failed:', err);
    process.exit(1);
  });

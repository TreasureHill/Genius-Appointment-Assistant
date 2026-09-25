// SerpApi `google_maps_reviews` source — the public Google Maps reviews of a
// place_id, one SerpApi search per page (Google serves 8 on the first page and
// up to 20 after). A full read of ~800 reviews is ~40 searches; an incremental
// sync that stops at the last review already stored is 1–3.
//
// Sort orders matter: SerpApi documents that "the total number of reviews
// returned may vary depending on the sorting option selected", and in
// practice Google's newest-first feed ends after a few dozen reviews. So a
// FULL read uses the default "most relevant" order (qualityScore), which pages
// through the whole listing, and only the incremental check uses newestFirst —
// escalating to a full read if that feed runs out before reaching `since`.
const axios = require('axios');

const SEARCH_URL = 'https://serpapi.com/search.json';
const ACCOUNT_URL = 'https://serpapi.com/account.json';
// "Treasure Hill - Corporate", 101 Bradwick Dr (the listing with ~770 reviews).
const DEFAULT_PLACE_ID = 'ChIJsWTRULwuK4gRwH-IdsUyVwE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SORT_ALL = 'qualityScore'; // Google's default "Most relevant": pages through every review
const SORT_NEWEST = 'newestFirst'; // a short feed of the latest reviews; fine for incremental checks

// SerpApi puts the token in `serpapi_pagination.next_page_token`; `next` is the
// full URL for the same page and carries it too, so accept either.
function nextTokenOf(data) {
  const pag = (data && data.serpapi_pagination) || {};
  if (pag.next_page_token) return String(pag.next_page_token);
  if (pag.next) {
    try {
      return new URL(pag.next).searchParams.get('next_page_token') || null;
    } catch {
      return null;
    }
  }
  return null;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// One SerpApi review object → the shape stored in the Review collection.
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const postedAt = toDate(item.iso_date);
  if (!postedAt) return null;
  let editedAt = toDate(item.iso_date_of_last_edit) || postedAt;
  if (editedAt < postedAt) editedAt = postedAt;
  const user = item.user || {};
  const text = item.snippet || (item.extracted_snippet && item.extracted_snippet.original) || '';
  const response = item.response || null;
  return {
    reviewId: item.review_id || item.link || `${user.name || 'anonymous'}-${postedAt.toISOString()}`,
    source: 'serpapi',
    reviewer: user.name || 'Anonymous',
    reviewerLink: user.link || '',
    reviewerAvatar: user.thumbnail || '',
    rating: Number(item.rating) || 0,
    text: String(text || ''),
    postedAt,
    editedAt,
    link: item.link || '',
    likes: Number(item.likes) || 0,
    reply: {
      text: response ? String(response.snippet || (response.extracted_snippet && response.extracted_snippet.original) || '') : '',
      at: response ? toDate(response.iso_date) : null,
    },
  };
}

function describeError(err) {
  if (!err) return 'unknown error';
  const data = err.response && err.response.data;
  if (data && typeof data === 'object' && data.error) return String(data.error);
  if (err.response && err.response.status) return `SerpApi HTTP ${err.response.status}`;
  if (err.code === 'ECONNABORTED') return 'SerpApi timed out';
  return err.message || String(err);
}

// Plan / quota for the "Test connection" button. Free: no search consumed.
async function fetchAccount(apiKey, { http = axios } = {}) {
  const { data } = await http.get(ACCOUNT_URL, { params: { api_key: apiKey }, timeout: 20_000 });
  if (!data || data.error) throw new Error((data && data.error) || 'SerpApi returned no account data');
  return {
    ok: true,
    email: data.account_email || '',
    plan: data.plan_name || '',
    searchesPerMonth: data.searches_per_month ?? null,
    usedThisMonth: data.this_month_usage ?? null,
    searchesLeft: data.total_searches_left ?? data.plan_searches_left ?? null,
    rateLimitPerHour: data.account_rate_limit_per_hour ?? null,
  };
}

// Page through the listing in `sortBy` order. With `since` (newest-first
// only), stop at the first review whose last edit is older than it — everything
// after is older still. Returns the normalised reviews, the listing's own
// totals, how many searches it cost, whether `since` was reached, and whether
// Google's feed simply ran out (`exhausted`).
async function fetchReviews({
  apiKey,
  placeId = DEFAULT_PLACE_ID,
  since = null,
  sortBy = since ? SORT_NEWEST : SORT_ALL,
  maxPages = 250,
  http = axios,
  pauseMs = 1000,
  onPage = null,
} = {}) {
  if (!apiKey) throw new Error('SerpApi key not configured');
  const reviews = [];
  const meta = {};
  let searches = 0;
  let nextToken = null;
  let stopped = false;
  let exhausted = false;

  while (!stopped && searches < maxPages) {
    const params = {
      engine: 'google_maps_reviews',
      place_id: placeId,
      sort_by: sortBy,
      hl: 'en',
      api_key: apiKey,
    };
    if (nextToken) {
      params.next_page_token = nextToken;
      params.num = 20; // only allowed after the first page (which is always 8)
    }
    const { data } = await http.get(SEARCH_URL, { params, timeout: 60_000 });
    searches += 1;
    if (!data || data.error) throw new Error(`SerpApi: ${(data && data.error) || 'empty response'}`);
    if (searches === 1) {
      const p = data.place_info || {};
      meta.title = p.title || '';
      meta.address = p.address || '';
      meta.rating = p.rating != null ? Number(p.rating) : null;
      meta.total = p.reviews != null ? Number(p.reviews) : null;
    }
    const items = Array.isArray(data.reviews) ? data.reviews : [];
    for (const item of items) {
      const r = normalizeItem(item);
      if (!r) continue;
      if (since && r.editedAt < since) {
        stopped = true;
        break;
      }
      reviews.push(r);
    }
    if (onPage) onPage({ page: searches, got: items.length, kept: reviews.length });
    if (stopped) break;
    nextToken = nextTokenOf(data);
    if (!nextToken || items.length === 0) {
      exhausted = true;
      break;
    }
    if (pauseMs) await sleep(pauseMs);
  }
  return {
    reviews,
    meta,
    searches,
    sortBy,
    reachedSince: stopped,
    exhausted,
    truncated: !stopped && !exhausted && searches >= maxPages,
  };
}

// One sync's worth of reading. Incremental (`since` set): walk the newest-first
// feed until a review older than `since` shows up. If that feed ends first,
// Google is only exposing its latest few dozen reviews and we cannot know what
// sits between them and `since`, so re-read the whole listing instead. Full
// (`since` null): the whole listing in "most relevant" order.
async function readListing({ apiKey, placeId = DEFAULT_PLACE_ID, since = null, ...rest } = {}) {
  const incremental = Boolean(since);
  let result = await fetchReviews({ apiKey, placeId, since, sortBy: incremental ? SORT_NEWEST : SORT_ALL, ...rest });
  let escalated = false;
  if (incremental && !result.reachedSince && !result.truncated) {
    escalated = true;
    const all = await fetchReviews({ apiKey, placeId, since: null, sortBy: SORT_ALL, ...rest });
    result = { ...all, meta: { ...result.meta, ...all.meta }, searches: result.searches + all.searches };
  }
  return { ...result, full: !incremental || escalated, escalated };
}

module.exports = {
  DEFAULT_PLACE_ID,
  SORT_ALL,
  SORT_NEWEST,
  normalizeItem,
  nextTokenOf,
  fetchAccount,
  fetchReviews,
  readListing,
  describeError,
};

// One sync step, shared by the Reviews tab ("Sync now") and the worker.
//
// Pulls new / edited reviews from SerpApi into the Review collection, keeping
// every manual mapping, re-runs the alias matcher on what came in, and records
// the run on Setting.reviews so the page can say how fresh the data is (or
// why the last refresh failed).
const Review = require('../../models/Review');
const Rep = require('../../models/Rep');
const Setting = require('../../models/Setting');
const env = require('../../config/env');
const serpapi = require('./serpapi');
const { compileMatchers, classifyText, effective } = require('./classify');

const MS_DAY = 24 * 60 * 60 * 1000;
let inflight = null;

function resolveKey(setting) {
  return String((setting && setting.reviews && setting.reviews.serpapiKey) || env.reviews.serpapiKey || '').trim();
}
function keySource(setting) {
  if (setting && setting.reviews && setting.reviews.serpapiKey) return 'settings';
  if (env.reviews.serpapiKey) return 'env';
  return '';
}
function resolvePlaceId(setting) {
  return String((setting && setting.reviews && setting.reviews.placeId) || env.reviews.placeId || serpapi.DEFAULT_PLACE_ID).trim();
}
function keyHint(key) {
  return key ? `…${key.slice(-4)}` : '';
}
function isRunning() {
  return Boolean(inflight);
}

async function loadMatchers(setting) {
  const reps = await Rep.find({ active: true }).lean();
  const s = setting || (await Setting.getSingleton());
  return compileMatchers({ reps, geniusTerms: (s.reviews && s.reviews.geniusTerms) || [] });
}

// Recompute the automatic tags on a document and refresh its effective fields.
function applyClassification(doc, matchers) {
  const c = classifyText(doc.text, matchers);
  doc.auto = { reps: c.reps, aliases: c.aliases, terms: c.terms, termHit: c.termHit, genius: c.genius };
  refreshEffective(doc);
}

function refreshEffective(doc) {
  const eff = effective(doc.auto, doc.manual);
  doc.reps = eff.reps;
  doc.genius = eff.genius;
  doc.mappingSource = eff.mappingSource;
}

const sameTime = (a, b) => (a ? new Date(a).getTime() : 0) === (b ? new Date(b).getTime() : 0);

// Insert or update. Manual mappings survive; auto tags are recomputed for
// every review that came in (cheap, and aliases may have changed since).
async function upsertReviews(list, matchers) {
  const now = new Date();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const r of list) {
    const existing = await Review.findOne({ reviewId: r.reviewId });
    if (!existing) {
      const doc = new Review({ ...r, effectiveAt: r.editedAt, firstSeenAt: now, lastSeenAt: now });
      applyClassification(doc, matchers);
      await doc.save();
      added += 1;
      continue;
    }
    const changed =
      !sameTime(existing.editedAt, r.editedAt) ||
      existing.text !== r.text ||
      Number(existing.rating) !== Number(r.rating) ||
      String((existing.reply && existing.reply.text) || '') !== String((r.reply && r.reply.text) || '');
    existing.set({
      source: r.source || existing.source,
      reviewer: r.reviewer,
      reviewerLink: r.reviewerLink || existing.reviewerLink,
      reviewerAvatar: r.reviewerAvatar || existing.reviewerAvatar,
      rating: r.rating,
      text: r.text,
      postedAt: r.postedAt,
      editedAt: r.editedAt,
      effectiveAt: r.editedAt,
      link: r.link || existing.link,
      likes: r.likes ?? existing.likes,
      reply: r.reply,
      lastSeenAt: now,
    });
    applyClassification(existing, matchers);
    await existing.save();
    if (changed) updated += 1;
    else unchanged += 1;
  }
  return { added, updated, unchanged };
}

async function recordSync(setting, patch) {
  setting.reviews = setting.reviews || {};
  setting.reviews.lastSync = { added: 0, updated: 0, searches: 0, warning: '', ...patch };
  await setting.save();
}

// A full read that came back with far fewer reviews than the listing reports
// is not "done" — say so, rather than presenting four weeks of data as all time.
function completenessWarning({ full, fetched, total }) {
  if (!full || !total || fetched >= total * 0.9) return '';
  return `Google served ${fetched} of the listing's ${total} reviews on this read — all-time numbers are incomplete. Try Full resync again later.`;
}

// full = re-read the whole listing (first run, or to catch edits to old
// reviews); otherwise stop two days before the newest review already stored
// so a late edit near the boundary is never missed.
async function runSync({ full = false, trigger = 'manual' } = {}) {
  if (inflight) {
    const err = new Error('A review sync is already running — try again in a minute.');
    err.status = 409;
    throw err;
  }
  inflight = (async () => {
    const setting = await Setting.getSingleton();
    const apiKey = resolveKey(setting);
    if (!apiKey) {
      const err = new Error('SerpApi key not configured. Paste it under Reviews → Setup, or set SERPAPI_KEY in .env.');
      err.status = 400;
      err.code = 'no_key';
      throw err;
    }
    const placeId = resolvePlaceId(setting);
    let since = null;
    if (!full) {
      const latest = await Review.findOne({}).sort({ effectiveAt: -1 }).select('effectiveAt').lean();
      if (latest) since = new Date(new Date(latest.effectiveAt).getTime() - 2 * MS_DAY);
      else full = true; // nothing stored yet: the first sync is the backfill
    }
    const startedAt = Date.now();
    try {
      const read = await serpapi.readListing({ apiKey, placeId, since });
      const { reviews, meta, searches, truncated, escalated } = read;
      full = read.full;
      const matchers = await loadMatchers(setting);
      const counts = await upsertReviews(reviews, matchers);
      const now = new Date();
      const stored = await Review.countDocuments();
      const summary =
        `${counts.added} new, ${counts.updated} updated · ${searches} search${searches === 1 ? '' : 'es'}` +
        (escalated ? ' · newest-first feed ran out, re-read the whole listing' : '') +
        (truncated ? ' · stopped at the page limit' : '');
      const warning = completenessWarning({ full, fetched: reviews.length, total: meta.total });
      setting.reviews = setting.reviews || {};
      setting.reviews.lastSyncAt = now;
      // A partial full read must not count as one, or the worker would wait a
      // month before trying again.
      if (full && !warning) setting.reviews.lastFullSyncAt = now;
      if (meta.total != null || meta.rating != null) {
        setting.reviews.listing = {
          title: meta.title || '',
          address: meta.address || '',
          rating: meta.rating ?? null,
          total: meta.total ?? null,
          updatedAt: now,
        };
      }
      await recordSync(setting, { ok: true, full, message: summary, warning, added: counts.added, updated: counts.updated, searches, at: now, trigger });
      console.log(`[reviews] ${full ? 'full' : 'incremental'} sync (${trigger}): ${summary}, ${stored} stored, ${Date.now() - startedAt} ms${warning ? ` — ${warning}` : ''}`);
      return { ok: true, full, ...counts, fetched: reviews.length, searches, truncated, escalated, warning, stored, at: now, listing: setting.reviews.listing };
    } catch (err) {
      const message = serpapi.describeError(err);
      await recordSync(setting, { ok: false, full, message, at: new Date(), trigger });
      console.error(`[reviews] sync failed (${trigger}): ${message}`);
      const out = new Error(message);
      out.status = err.status || 502;
      throw out;
    }
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// True when the store holds clearly fewer reviews than the listing reports —
// e.g. a backfill made while the newest-first feed was the only source. The
// worker then treats the next run as a full read.
async function storeLooksPartial(setting) {
  const rv = (setting && setting.reviews) || {};
  const total = rv.listing && rv.listing.total;
  if (!total) return false;
  const stored = await Review.countDocuments();
  return stored < total * 0.9;
}

// Re-run the matcher over every stored review (after reps / aliases / Genius
// terms change). Manual mappings are untouched.
async function rematchAll() {
  const matchers = await loadMatchers();
  let scanned = 0;
  let changed = 0;
  const cursor = Review.find({}).cursor();
  for await (const doc of cursor) {
    scanned += 1;
    const before = JSON.stringify([doc.reps.map(String), doc.genius, doc.mappingSource, (doc.auto && doc.auto.reps || []).map(String), doc.auto && doc.auto.termHit]);
    applyClassification(doc, matchers);
    const after = JSON.stringify([doc.reps.map(String), doc.genius, doc.mappingSource, doc.auto.reps.map(String), doc.auto.termHit]);
    if (before !== after) {
      changed += 1;
      await doc.save();
    }
  }
  return { scanned, changed };
}

// Load reviews from JSON (a manual export, or the demo fixture). Accepts the
// Python tool's fixture shape ({ reviews: [{ review_id, reviewer, rating, text,
// created_at, updated_at, link, reply }], meta }) and this API's own shape.
function normalizeImported(r) {
  const postedAt = new Date(r.postedAt || r.created_at || r.createdAt);
  if (Number.isNaN(postedAt.getTime())) return null;
  let editedAt = new Date(r.editedAt || r.updated_at || r.updatedAt || postedAt);
  if (Number.isNaN(editedAt.getTime()) || editedAt < postedAt) editedAt = postedAt;
  const reviewId = String(r.reviewId || r.review_id || r.id || r.link || `${r.reviewer || 'anonymous'}-${postedAt.toISOString()}`);
  const reply = typeof r.reply === 'string' ? { text: r.reply, at: null } : r.reply || { text: '', at: null };
  return {
    reviewId,
    source: r.source && ['serpapi', 'gbp', 'import', 'manual'].includes(r.source) ? r.source : 'import',
    reviewer: String(r.reviewer || 'Anonymous'),
    reviewerLink: r.reviewerLink || '',
    reviewerAvatar: r.reviewerAvatar || '',
    rating: Math.max(0, Math.min(5, Number(r.rating) || 0)),
    text: String(r.text || ''),
    postedAt,
    editedAt,
    link: r.link || '',
    likes: Number(r.likes) || 0,
    reply: { text: String(reply.text || ''), at: reply.at ? new Date(reply.at) : null },
  };
}

async function importReviews(payload = {}) {
  const raw = Array.isArray(payload) ? payload : payload.reviews;
  if (!Array.isArray(raw)) {
    const err = new Error('Expected { "reviews": [ … ] }');
    err.status = 400;
    throw err;
  }
  const list = raw.map(normalizeImported).filter(Boolean);
  const setting = await Setting.getSingleton();
  const matchers = await loadMatchers(setting);
  const counts = await upsertReviews(list, matchers);
  const meta = payload.meta || {};
  if (meta.total_review_count != null || meta.average_rating != null || meta.total != null || meta.rating != null) {
    setting.reviews = setting.reviews || {};
    setting.reviews.listing = {
      title: meta.title || (setting.reviews.listing && setting.reviews.listing.title) || '',
      address: meta.address || (setting.reviews.listing && setting.reviews.listing.address) || '',
      rating: meta.average_rating ?? meta.rating ?? null,
      total: meta.total_review_count ?? meta.total ?? null,
      updatedAt: new Date(),
    };
    await setting.save();
  }
  return { ok: true, received: raw.length, ...counts, stored: await Review.countDocuments() };
}

module.exports = {
  runSync,
  rematchAll,
  importReviews,
  isRunning,
  storeLooksPartial,
  completenessWarning,
  resolveKey,
  keySource,
  resolvePlaceId,
  keyHint,
  loadMatchers,
  applyClassification,
  refreshEffective,
  upsertReviews,
  normalizeImported,
};

const express = require('express');
const mongoose = require('mongoose');
const Review = require('../models/Review');
const Rep = require('../models/Rep');
const Setting = require('../models/Setting');
const env = require('../config/env');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const sync = require('../services/reviews/sync');
const serpapi = require('../services/reviews/serpapi');
const { resolveWindow, computeStats } = require('../services/reviews/stats');
const { buildDeck, deckFilename } = require('../services/reviews/deck');
const { buildWorkbook } = require('../services/reviews/excel');
const { classifyText, normalizeTerm } = require('../services/reviews/classify');

// The Reviews tab: Google reviews of the listing, credited to our reps.
//   GET    /config, PATCH /config, POST /test-connection, POST /sync
//   GET    /stats?start&end            the week's numbers, reps, trend
//   GET    /?start&end&show&rep&q…     the paginated review log
//   PATCH  /:id/mapping                map a review to reps / force Genius
//   GET|POST /reps, PATCH|DELETE /reps/:id, POST /rematch, POST /classify
//   POST   /import                     reviews from JSON
//   GET    /deck.pptx, /export.xlsx    the weekly deck / Excel workbook
const router = express.Router();

const REP_FIELDS = 'name color active role sortOrder';
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (x) => (x && x.toObject ? x.toObject() : x) || {};

function bad(res, message, status = 400) {
  return res.status(status).json({ error: message, message });
}

function normalizeTerms(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,\n]/);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const t = normalizeTerm(raw);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function counts() {
  const [reviews, genius, unmapped, reps, manual] = await Promise.all([
    Review.countDocuments(),
    Review.countDocuments({ genius: true }),
    Review.countDocuments({ genius: true, reps: { $size: 0 } }),
    Rep.countDocuments({ active: true }),
    Review.countDocuments({ mappingSource: 'manual' }),
  ]);
  return { reviews, genius, unmapped, reps, manual };
}

// The schema gives lastSync defaults (ok:false, at:null) before any run — the
// page must read that as "never synced", not as a failure.
const lastSyncOf = (rv) => (rv.lastSync && rv.lastSync.at ? rv.lastSync : null);

function configJson(setting, c) {
  const rv = plain(setting.reviews);
  const key = sync.resolveKey(setting);
  return {
    serpapiKeySet: Boolean(key),
    serpapiKeyHint: sync.keyHint(key),
    serpapiKeySource: sync.keySource(setting),
    placeId: sync.resolvePlaceId(setting),
    placeIdSource: rv.placeId ? 'settings' : env.reviews.placeId ? 'env' : 'default',
    defaultPlaceId: serpapi.DEFAULT_PLACE_ID,
    geniusTerms: rv.geniusTerms || [],
    autoSyncHours: rv.autoSyncHours ?? 12,
    fullSyncDays: rv.fullSyncDays ?? 30,
    companyName: rv.companyName || 'TREASURE HILL',
    reportTitle: rv.reportTitle || 'Genius Google Reviews',
    lastSyncAt: rv.lastSyncAt || null,
    lastFullSyncAt: rv.lastFullSyncAt || null,
    lastSync: lastSyncOf(rv),
    listing: rv.listing || null,
    syncRunning: sync.isRunning(),
    timezone: resolveScheduleTimezone(setting),
    counts: c,
  };
}

// Everything the stats, deck and export share for one window.
async function gather(req) {
  const setting = await Setting.getSingleton();
  const tz = resolveScheduleTimezone(setting);
  const window = resolveWindow({ tz, start: req.query.start, end: req.query.end });
  const [reviews, reps] = await Promise.all([Review.find({}).lean(), Rep.find({}).sort({ sortOrder: 1, name: 1 }).lean()]);
  const stats = computeStats({ reviews, reps, window, tz });
  const rv = plain(setting.reviews);
  stats.listing = rv.listing || null;
  return { setting, tz, window, reviews, reps, stats, rv };
}

// --- setup ------------------------------------------------------------------
router.get('/config', async (req, res) => {
  const setting = await Setting.getSingleton();
  res.json(configJson(setting, await counts()));
});

router.patch('/config', async (req, res) => {
  const { serpapiKey, placeId, geniusTerms, autoSyncHours, fullSyncDays, companyName, reportTitle } = req.body || {};
  const setting = await Setting.getSingleton();
  setting.reviews = setting.reviews || {};
  let rematch = false;
  if (serpapiKey != null) setting.reviews.serpapiKey = String(serpapiKey).trim();
  if (placeId != null) setting.reviews.placeId = String(placeId).trim();
  if (geniusTerms != null) {
    const terms = normalizeTerms(geniusTerms);
    if (JSON.stringify(terms) !== JSON.stringify(setting.reviews.geniusTerms || [])) {
      setting.reviews.geniusTerms = terms;
      rematch = true;
    }
  }
  for (const [key, value] of [
    ['autoSyncHours', autoSyncHours],
    ['fullSyncDays', fullSyncDays],
  ]) {
    if (value == null) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return bad(res, `${key} must be a number ≥ 0`);
    setting.reviews[key] = n;
  }
  if (companyName != null) setting.reviews.companyName = String(companyName).trim() || 'TREASURE HILL';
  if (reportTitle != null) setting.reviews.reportTitle = String(reportTitle).trim() || 'Genius Google Reviews';
  await setting.save();
  const result = rematch ? await sync.rematchAll() : null;
  res.json({ ...configJson(setting, await counts()), rematch: result });
});

// SerpApi account check — free (no search consumed). Uses the key in the
// body when given (so a pasted key can be checked before saving).
router.post('/test-connection', async (req, res) => {
  const given = String((req.body && req.body.serpapiKey) || '').trim();
  const setting = await Setting.getSingleton();
  const key = given || sync.resolveKey(setting);
  if (!key) return bad(res, 'No SerpApi key to test. Paste one first, or set SERPAPI_KEY in .env.');
  try {
    const account = await serpapi.fetchAccount(key);
    res.json({ ...account, keyHint: sync.keyHint(key), source: given ? 'form' : sync.keySource(setting) });
  } catch (err) {
    res.status(400).json({ ok: false, error: serpapi.describeError(err), message: serpapi.describeError(err) });
  }
});

router.post('/sync', async (req, res) => {
  const full = Boolean(req.body && req.body.full);
  try {
    const result = await sync.runSync({ full, trigger: `manual:${(req.user && req.user.username) || 'user'}` });
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, message: err.message, code: err.code || '' });
  }
});

router.get('/sync/status', (req, res) => {
  res.json({ running: sync.isRunning() });
});

// --- numbers ----------------------------------------------------------------
router.get('/stats', async (req, res) => {
  const { setting, tz, stats, rv } = await gather(req);
  const { weekReviews, ...rest } = stats;
  res.json({
    ...rest,
    timezone: tz,
    lastSync: lastSyncOf(rv),
    lastSyncAt: rv.lastSyncAt || null,
    autoSyncHours: rv.autoSyncHours ?? 12,
    syncRunning: sync.isRunning(),
    keySet: Boolean(sync.resolveKey(setting)),
    stored: stats.allTime.total,
  });
});

// --- the log ----------------------------------------------------------------
const SORTS = {
  newest: { effectiveAt: -1 },
  oldest: { effectiveAt: 1 },
  rating_low: { rating: 1, effectiveAt: -1 },
  rating_high: { rating: -1, effectiveAt: -1 },
};

router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 25));
  const { show = 'all', rep = '', q = '', sort = 'newest', scope = 'window' } = req.query;
  const setting = await Setting.getSingleton();
  const tz = resolveScheduleTimezone(setting);
  const filter = {};
  let window = null;
  if (scope !== 'all') {
    window = resolveWindow({ tz, start: req.query.start, end: req.query.end });
    filter.effectiveAt = { $gte: window.startAt, $lt: window.endAt };
  }
  switch (show) {
    case 'genius':
      filter.genius = true;
      break;
    case 'other':
      filter.genius = false;
      break;
    case 'unmapped':
      filter.genius = true;
      filter.reps = { $size: 0 };
      break;
    case 'five':
      filter.rating = 5;
      break;
    case 'low':
      filter.rating = { $gt: 0, $lte: 3 };
      break;
    case 'unreplied':
      filter['reply.text'] = { $in: ['', null] };
      break;
    case 'manual':
      filter.mappingSource = 'manual';
      break;
    default:
      break;
  }
  if (rep) {
    if (rep === 'none') filter.reps = { $size: 0 };
    else if (mongoose.isValidObjectId(rep)) filter.reps = new mongoose.Types.ObjectId(rep);
    else return bad(res, 'Unknown rep');
  }
  if (q) {
    const r = new RegExp(escapeRegex(String(q).trim()), 'i');
    filter.$or = [{ reviewer: r }, { text: r }, { 'reply.text': r }];
  }
  const sortSpec = SORTS[sort] || SORTS.newest;
  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort(sortSpec)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate('reps', REP_FIELDS)
      .populate('auto.reps', REP_FIELDS)
      .populate('manual.reps', REP_FIELDS)
      .lean(),
    Review.countDocuments(filter),
  ]);
  res.json({
    items,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    timezone: tz,
    window: window ? { start: window.start, end: window.end, label: window.label } : null,
  });
});

async function populated(id) {
  return Review.findById(id).populate('reps', REP_FIELDS).populate('auto.reps', REP_FIELDS).populate('manual.reps', REP_FIELDS).lean();
}

// Manual mapping. Body:
//   reps:   [repId] → credit exactly these reps ([] = nobody); null → back to auto
//   genius: true | false → force the Genius flag; null → back to auto
//   note:   free text shown on the review
router.patch('/:id/mapping', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, 'Unknown review', 404);
  const doc = await Review.findById(req.params.id);
  if (!doc) return bad(res, 'Unknown review', 404);
  const { reps, genius, note } = req.body || {};
  if (reps !== undefined) {
    if (reps === null) {
      doc.manual.repsSet = false;
      doc.manual.reps = [];
    } else {
      if (!Array.isArray(reps)) return bad(res, 'reps must be a list of rep ids, or null');
      const ids = [...new Set(reps.map(String))];
      if (!ids.every((id) => mongoose.isValidObjectId(id))) return bad(res, 'reps must be rep ids');
      const found = await Rep.countDocuments({ _id: { $in: ids } });
      if (found !== ids.length) return bad(res, 'One of those reps no longer exists');
      doc.manual.repsSet = true;
      doc.manual.reps = ids;
    }
  }
  if (genius !== undefined) {
    if (genius !== null && typeof genius !== 'boolean') return bad(res, 'genius must be true, false or null');
    doc.manual.genius = genius;
  }
  if (note !== undefined) doc.manual.note = String(note || '').slice(0, 1000);
  doc.manual.updatedAt = new Date();
  doc.manual.updatedBy = (req.user && req.user.username) || '';
  sync.refreshEffective(doc);
  await doc.save();
  res.json(await populated(doc._id));
});

// --- reps -------------------------------------------------------------------
async function repsWithCounts() {
  const [reps, totals] = await Promise.all([
    Rep.find({}).sort({ sortOrder: 1, name: 1 }).lean(),
    Review.aggregate([{ $unwind: '$reps' }, { $group: { _id: '$reps', n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(totals.map((t) => [String(t._id), t.n]));
  return reps.map((r) => ({ ...r, reviewCount: byId.get(String(r._id)) || 0 }));
}

router.get('/reps', async (req, res) => {
  res.json(await repsWithCounts());
});

router.post('/reps', async (req, res) => {
  const { name, aliases, role, color } = req.body || {};
  const clean = String(name || '').trim();
  if (!clean) return bad(res, 'Name is required');
  if (await Rep.findOne({ name: new RegExp(`^${escapeRegex(clean)}$`, 'i') })) return bad(res, `"${clean}" already exists`);
  const n = await Rep.countDocuments();
  const rep = await Rep.create({
    name: clean,
    aliases: Rep.normalizeAliases(clean, aliases),
    role: role != null ? String(role).trim() : 'Genius technician',
    color: /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : Rep.COLORS[n % Rep.COLORS.length],
    sortOrder: n,
  });
  const rematch = await sync.rematchAll();
  res.status(201).json({ rep: rep.toObject(), rematch });
});

router.patch('/reps/:id', async (req, res) => {
  const rep = mongoose.isValidObjectId(req.params.id) ? await Rep.findById(req.params.id) : null;
  if (!rep) return bad(res, 'Unknown rep', 404);
  const { name, aliases, role, color, active, sortOrder } = req.body || {};
  let matching = false;
  if (name != null) {
    const clean = String(name).trim();
    if (!clean) return bad(res, 'Name is required');
    const dupe = await Rep.findOne({ _id: { $ne: rep._id }, name: new RegExp(`^${escapeRegex(clean)}$`, 'i') });
    if (dupe) return bad(res, `"${clean}" already exists`);
    if (clean !== rep.name) matching = true;
    rep.name = clean;
  }
  if (aliases != null) {
    const next = Rep.normalizeAliases(rep.name, aliases);
    if (JSON.stringify(next) !== JSON.stringify(rep.aliases)) matching = true;
    rep.aliases = next;
  } else if (name != null) {
    rep.aliases = Rep.normalizeAliases(rep.name, rep.aliases);
  }
  if (role != null) rep.role = String(role).trim();
  if (color != null && /^#[0-9a-f]{6}$/i.test(String(color))) rep.color = color;
  if (active != null) {
    if (Boolean(active) !== rep.active) matching = true;
    rep.active = Boolean(active);
  }
  if (sortOrder != null && Number.isFinite(Number(sortOrder))) rep.sortOrder = Number(sortOrder);
  await rep.save();
  const rematch = matching ? await sync.rematchAll() : null;
  res.json({ rep: rep.toObject(), rematch });
});

// Deleting a rep also drops it from every review (auto and manual) — prefer
// deactivating, which keeps the history.
router.delete('/reps/:id', async (req, res) => {
  const rep = mongoose.isValidObjectId(req.params.id) ? await Rep.findById(req.params.id) : null;
  if (!rep) return bad(res, 'Unknown rep', 404);
  await rep.deleteOne();
  await Review.updateMany({ $or: [{ reps: rep._id }, { 'manual.reps': rep._id }, { 'auto.reps': rep._id }] }, { $pull: { reps: rep._id, 'manual.reps': rep._id, 'auto.reps': rep._id } });
  const rematch = await sync.rematchAll();
  res.json({ ok: true, rematch });
});

router.post('/rematch', async (req, res) => {
  res.json(await sync.rematchAll());
});

// Try the matcher on a sentence (the "test a phrase" box next to the aliases).
router.post('/classify', async (req, res) => {
  const text = String((req.body && req.body.text) || '');
  const matchers = await sync.loadMatchers();
  const c = classifyText(text, matchers);
  const names = new Map(matchers.reps.map((r) => [r.id, r.name]));
  res.json({ ...c, repNames: c.reps.map((id) => names.get(id) || id) });
});

// --- import / export ---------------------------------------------------------
router.post('/import', async (req, res) => {
  try {
    res.json(await sync.importReviews(req.body));
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, message: err.message });
  }
});

router.get('/deck.pptx', async (req, res) => {
  const { stats, tz, rv } = await gather(req);
  const buf = await buildDeck({ stats, companyName: rv.companyName || 'TREASURE HILL', reportTitle: rv.reportTitle || 'Genius Google Reviews', tz });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="${deckFilename(stats)}"`);
  res.send(buf);
});

router.get('/export.xlsx', async (req, res) => {
  const { stats, tz, reviews, reps, rv } = await gather(req);
  const buf = buildWorkbook({ stats, allReviews: reviews.slice().sort((a, b) => new Date(b.effectiveAt) - new Date(a.effectiveAt)), reps, tz, listing: rv.listing || null });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="genius-google-reviews-${stats.window.start}_to_${stats.window.end}.xlsx"`);
  res.send(buf);
});

module.exports = router;

const mongoose = require('mongoose');
const AlarmContract = require('../../models/AlarmContract');
const ContractPayment = require('../../models/ContractPayment');
const WebhookEvent = require('../../models/WebhookEvent');
const Project = require('../../models/Project');
const env = require('../../config/env');
const { CONTRACT_STATUSES, ACTION_GUARDS } = require('./status');
const { monthsBetween, cardExpiresBefore } = require('./schedule');

// Contracts dashboard numbers (GET /api/contracts/summary, the paged table,
// the CSV export and the Dashboard "Monitoring" tiles).
//
// Owner: admin API track. Definitions (plan + reviewer item 16):
//  - MRR = Σ pricing.unitCents over active|past_due|unpaid (pre-tax);
//    mrrInclTaxCents = Σ totalCents
//  - collected = Σ (amountPaidCents − amountRefundedCents) over paid
//    ContractPayment in the date filter; tax separately
//  - missed = ContractPayment.missed (billing.isMissed), per billing period
//  - months active = schedule.monthsBetween(billing.startedAt, billing.endedAt || now)
//  - awaiting payment uses signedAt as the contract start
//
// Counts, pipeline and per-project numbers only look at CURRENT contracts
// (isCurrent:true): a regenerated lot would otherwise show its old voided
// contract next to the new draft and count the lot twice. Money (collected,
// missed, chart) looks at every contract, because an old contract can still
// have real payments behind it.
//
// The heavy lifting is split into pure helpers (computeSummary, buildChart,
// toRow, rowsToCsv, buildListFilter …) so the numbers can be tested without a
// database; the async functions only fetch.

const MS_DAY = 24 * 60 * 60 * 1000;
// Statuses that bill every month (MRR, package mix of paying customers).
const BILLING_LIVE = ['active', 'past_due', 'unpaid'];
// Statuses with a next charge date worth showing.
const CHARGING = ['active', 'past_due'];
const STALE_AWAITING_PAYMENT_DAYS = 7;
const COMPLETION_STUCK_MS = 60 * 60 * 1000;
const CARD_EXPIRY_WINDOW_DAYS = 30;
const MAX_LIMIT = 200;
const ALERT_LIMIT = 50;

// The lean projection every pure helper below needs (no PDFs, no events).
const ROW_FIELDS =
  'number status needsAttention signingMode purchasers.name purchasers.email purchasers.role purchasers.signs ' +
  'purchasers.signStatus project lot property package pricing signedAt envelope.status envelope.sentAt ' +
  'envelope.completedAt envelope.completionDoneAt envelope.completionClaimedAt billing reminders.enabled ' +
  'invoiceEmails.enabled isCurrent createdAt updatedAt';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toDate(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "a,b" | ['a','b'] | 'a' → ['a','b'] (trimmed, no blanks).
function toList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Date-only value ("2026-11-03" or any parseable date) → that calendar day at
 * 12:00 UTC, the convention for closing dates (same day in every North
 * American zone). Returns null for blank, undefined for invalid input.
 */
function parseDateOnly(v) {
  if (v == null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
    // Reject 2026-02-31 style rollovers.
    if (d.getUTCMonth() !== Number(m[2]) - 1) return undefined;
    return d;
  }
  const d = toDate(v);
  if (!d) return undefined;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
}

// 'YYYY-MM' (UTC) for a date.
function monthKey(d) {
  const x = toDate(d);
  if (!x) return '';
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The `n` month keys ending with now's month, oldest first.
function monthKeys(now = new Date(), n = 12) {
  const out = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = n - 1; i >= 0; i -= 1) out.push(monthKey(new Date(Date.UTC(y, m - i, 1))));
  return out;
}

/**
 * 12-month paid vs failed series (pure). Input rows come from the payments
 * aggregate: {month:'YYYY-MM', kind:'paid'|'failed', cents, count}. Months with
 * no rows are filled with zeros so the chart has a steady x axis.
 */
function buildChart(rows = [], now = new Date(), n = 12) {
  const byMonth = new Map(monthKeys(now, n).map((k) => [k, { month: k, paidCents: 0, paidCount: 0, failedCents: 0, failedCount: 0 }]));
  for (const r of rows) {
    const slot = byMonth.get(r.month);
    if (!slot) continue;
    if (r.kind === 'paid') {
      slot.paidCents += r.cents || 0;
      slot.paidCount += r.count || 0;
    } else if (r.kind === 'failed') {
      slot.failedCents += r.cents || 0;
      slot.failedCount += r.count || 0;
    }
  }
  return [...byMonth.values()];
}

// The billing start used for "months active". Contracts that never started
// billing have no duration.
function monthsActiveFor(c, now = new Date()) {
  const b = (c && c.billing) || {};
  if (!b.startedAt) return 0;
  return monthsBetween(b.startedAt, b.endedAt || now);
}

// Next charge = the period end of a subscription that will renew.
function nextChargeFor(c) {
  const b = (c && c.billing) || {};
  if (!CHARGING.includes(c && c.status)) return null;
  if (b.cancelAtPeriodEnd) return null;
  return toDate(b.currentPeriodEnd);
}

const idOf = (v) => (v && v._id ? v._id : v);
const idStr = (v) => (v == null ? '' : String(idOf(v)));

function primaryPurchaser(c) {
  const ps = (c && c.purchasers) || [];
  return ps.find((p) => p && p.role === 'buyer' && (p.name || p.email)) || ps.find((p) => p && (p.name || p.email)) || null;
}

/**
 * One table row (pure). `c` is a lean contract with `project` / `lot`
 * optionally populated ({_id, name} / {_id, lotNumber}).
 */
function toRow(c, now = new Date()) {
  const b = c.billing || {};
  const pricing = c.pricing || {};
  const project = c.project && c.project._id ? c.project : { _id: c.project || null, name: '' };
  const lot = c.lot && c.lot._id ? c.lot : { _id: c.lot || null, lotNumber: '' };
  return {
    _id: c._id,
    number: c.number || '',
    status: c.status || 'draft',
    needsAttention: c.needsAttention || '',
    signingMode: c.signingMode || 'remote',
    isCurrent: c.isCurrent !== false,
    purchasers: (c.purchasers || []).filter((p) => p && (p.name || p.email)).map((p) => ({ name: p.name || '', email: p.email || '' })),
    project: { _id: project._id, name: project.name || (c.property && c.property.projectName) || '' },
    lot: { _id: lot._id, lotNumber: lot.lotNumber || (c.property && c.property.lotNumber) || '' },
    package: c.package || null,
    unitCents: pricing.unitCents == null ? null : pricing.unitCents,
    totalCents: pricing.totalCents == null ? null : pricing.totalCents,
    signedAt: c.signedAt || null,
    startedAt: b.startedAt || null,
    monthsActive: monthsActiveFor(c, now),
    paidCount: b.paidCount || 0,
    totalPaidCents: b.totalPaidCents || 0,
    missedCount: b.missedCount || 0,
    missedOpenCents: b.missedOpenCents || 0,
    consecutiveMissed: b.consecutiveMissed || 0,
    nextChargeAt: nextChargeFor(c),
    cancelAtPeriodEnd: Boolean(b.cancelAtPeriodEnd),
    remindersEnabled: !(c.reminders && c.reminders.enabled === false),
    invoiceEmailsEnabled: !(c.invoiceEmails && c.invoiceEmails.enabled === false),
    createdAt: c.createdAt || null,
  };
}

/**
 * Mongo filter for the table / CSV (pure).
 * @param {{status?, project?, q?, due?: '7d', reminders?: 'on'|'off', needsAttention?: '1',
 *   missed?: '1', current?: '0'|'1'}} f
 */
function buildListFilter(f = {}, now = new Date()) {
  const filter = {};
  // History (non-current contracts) only on request.
  if (String(f.current ?? '1') !== '0') filter.isCurrent = true;
  let statuses = toList(f.status).filter((s) => CONTRACT_STATUSES.includes(s));
  // "Charges in the next 7 days" only makes sense for renewing subscriptions.
  if (f.due === '7d') statuses = statuses.length ? statuses.filter((s) => CHARGING.includes(s)) : CHARGING;
  if (statuses.length === 1) filter.status = statuses[0];
  else if (statuses.length > 1 || f.due === '7d') filter.status = { $in: statuses };
  const projects = toList(f.project || f.projects).filter((p) => mongoose.isValidObjectId(p));
  if (projects.length === 1) filter.project = projects[0];
  else if (projects.length > 1) filter.project = { $in: projects };
  if (f.due === '7d') {
    filter['billing.cancelAtPeriodEnd'] = { $ne: true };
    filter['billing.currentPeriodEnd'] = { $gte: now, $lte: new Date(now.getTime() + 7 * MS_DAY) };
  }
  if (f.reminders === 'off') filter['reminders.enabled'] = false;
  else if (f.reminders === 'on') filter['reminders.enabled'] = { $ne: false };
  if (String(f.needsAttention || '') === '1') filter.needsAttention = { $nin: ['', null] };
  if (String(f.missed || '') === '1') filter['billing.missedCount'] = { $gt: 0 };
  const q = String(f.q || '').trim();
  if (q) {
    const r = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { number: r },
      { 'purchasers.name': r },
      { 'purchasers.email': r },
      { 'purchasers.phone': r },
      { 'property.lotNumber': r },
      { 'property.address': r },
      { 'property.projectName': r },
    ];
  }
  return filter;
}

// Allowed sort keys → Mongo sort. Anything else falls back to newest first.
const SORTS = {
  createdAt: { createdAt: 1 },
  number: { number: 1 },
  status: { status: 1, createdAt: -1 },
  signedAt: { signedAt: 1 },
  startedAt: { 'billing.startedAt': 1 },
  nextCharge: { 'billing.currentPeriodEnd': 1 },
  paid: { 'billing.totalPaidCents': 1 },
  missed: { 'billing.missedCount': 1, 'billing.consecutiveMissed': 1 },
  package: { package: 1 },
  lot: { 'property.lotNumber': 1 },
};

function sortSpec(sort) {
  const s = String(sort || '-createdAt');
  const desc = s.startsWith('-');
  const key = desc ? s.slice(1) : s;
  const base = SORTS[key] || null;
  if (!base) return { createdAt: -1, _id: -1 };
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = desc ? -v : v;
  out._id = desc ? -1 : 1; // stable paging
  return out;
}

function pageParams(f = {}) {
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), MAX_LIMIT);
  const page = Math.max(parseInt(f.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

// CSV cell: quote when needed, and defuse spreadsheet formulas (a purchaser
// name starting with "=" must not run in Excel).
function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));

const CSV_COLUMNS = [
  ['Contract', (r) => r.number],
  ['Status', (r) => r.status],
  ['Needs attention', (r) => r.needsAttention],
  ['Purchasers', (r) => r.purchasers.map((p) => p.name || p.email).join('; ')],
  ['Emails', (r) => r.purchasers.map((p) => p.email).filter(Boolean).join('; ')],
  ['Project', (r) => r.project.name],
  ['Lot', (r) => r.lot.lotNumber],
  ['Package', (r) => r.package || ''],
  ['Monthly (pre-tax)', (r) => dollars(r.unitCents)],
  ['Monthly incl. HST', (r) => dollars(r.totalCents)],
  ['Signing mode', (r) => r.signingMode],
  ['Signed', (r) => r.signedAt],
  ['Started', (r) => r.startedAt],
  ['Months active', (r) => r.monthsActive],
  ['Payments', (r) => r.paidCount],
  ['Total paid', (r) => dollars(r.totalPaidCents)],
  ['Missed', (r) => r.missedCount],
  ['Consecutive missed', (r) => r.consecutiveMissed],
  ['Missed open', (r) => dollars(r.missedOpenCents)],
  ['Next charge', (r) => r.nextChargeAt],
  ['Reminders', (r) => (r.remindersEnabled ? 'on' : 'off')],
  ['Invoice emails', (r) => (r.invoiceEmailsEnabled ? 'on' : 'off')],
  ['Created', (r) => r.createdAt],
];

/** Rows → CSV text with a header row (pure). CRLF line ends for Excel. */
function rowsToCsv(rows = []) {
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Contract-side numbers of the summary (pure).
 * @param {object[]} contracts lean CURRENT contracts (ROW_FIELDS)
 * @param {{now?: Date, projectNames?: Map<string,string>}} [o]
 */
function computeSummary(contracts = [], { now = new Date(), projectNames = new Map() } = {}) {
  const counts = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0]));
  counts.needsAttention = 0;
  counts.total = 0;
  let mrrCents = 0;
  let mrrInclTaxCents = 0;
  let monthsSum = 0;
  let monthsN = 0;
  let oldestSentAt = null;
  const awaitingPayment = { count: 0, staleCount: 0 };
  const upcoming7d = { count: 0, cents: 0 };
  const packageMix = { basic: 0, smart: 0 };
  const byProject = new Map();
  const in7d = now.getTime() + 7 * MS_DAY;
  const staleBefore = now.getTime() - STALE_AWAITING_PAYMENT_DAYS * MS_DAY;

  for (const c of contracts) {
    const status = c.status || 'draft';
    if (counts[status] != null) counts[status] += 1;
    counts.total += 1;
    if (c.needsAttention) counts.needsAttention += 1;
    const p = c.pricing || {};
    const live = BILLING_LIVE.includes(status);
    if (live) {
      mrrCents += p.unitCents || 0;
      mrrInclTaxCents += p.totalCents || 0;
      if (c.package && packageMix[c.package] != null) packageMix[c.package] += 1;
    }
    if (c.billing && c.billing.startedAt) {
      monthsSum += monthsActiveFor(c, now);
      monthsN += 1;
    }
    if (status === 'sent') {
      const sentAt = toDate(c.envelope && c.envelope.sentAt) || toDate(c.createdAt);
      if (sentAt && (!oldestSentAt || sentAt < oldestSentAt)) oldestSentAt = sentAt;
    }
    if (status === 'awaiting_payment') {
      awaitingPayment.count += 1;
      const signed = toDate(c.signedAt);
      if (signed && signed.getTime() < staleBefore) awaitingPayment.staleCount += 1;
    }
    const next = nextChargeFor(c);
    if (next && next.getTime() >= now.getTime() && next.getTime() <= in7d) {
      upcoming7d.count += 1;
      upcoming7d.cents += p.totalCents || 0;
    }
    const pid = idStr(c.project);
    if (pid) {
      const row = byProject.get(pid) || {
        projectId: pid,
        name: projectNames.get(pid) || (c.project && c.project.name) || (c.property && c.property.projectName) || '',
        active: 0,
        total: 0,
        mrrCents: 0,
      };
      row.total += 1;
      if (status === 'active') row.active += 1;
      if (live) row.mrrCents += p.unitCents || 0;
      byProject.set(pid, row);
    }
  }

  return {
    counts,
    mrrCents,
    mrrInclTaxCents,
    avgMonthsActive: monthsN ? Math.round((monthsSum / monthsN) * 10) / 10 : 0,
    awaitingSignature: {
      count: counts.sent,
      oldestDays: oldestSentAt ? Math.floor((now.getTime() - oldestSentAt.getTime()) / MS_DAY) : 0,
    },
    awaitingPayment,
    upcoming7d,
    packageMix,
    byProject: [...byProject.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

/**
 * Contract-derived alerts (pure): package missing, cards expiring within 30
 * days on renewing subscriptions, completions stuck for over an hour.
 */
function contractAlerts(contracts = [], now = new Date()) {
  const alerts = [];
  const expiryHorizon = new Date(now.getTime() + CARD_EXPIRY_WINDOW_DAYS * MS_DAY);
  for (const c of contracts) {
    const base = { contractId: c._id, number: c.number || '' };
    if (c.needsAttention === 'package_missing') {
      alerts.push({ kind: 'package_missing', ...base, message: `${c.number}: signed without a monitoring package; set it before payment.` });
    }
    const b = c.billing || {};
    if (CHARGING.includes(c.status) && !b.cancelAtPeriodEnd && cardExpiresBefore({ expMonth: b.pmExpMonth, expYear: b.pmExpYear }, expiryHorizon)) {
      alerts.push({
        kind: 'card_expiring',
        ...base,
        message: `${c.number}: card ending ${b.pmLast4 || '????'} expires ${String(b.pmExpMonth).padStart(2, '0')}/${b.pmExpYear}.`,
      });
    }
    const e = c.envelope || {};
    const completedAt = toDate(e.completedAt);
    if (e.status === 'completed' && !e.completionDoneAt && completedAt && now.getTime() - completedAt.getTime() > COMPLETION_STUCK_MS) {
      alerts.push({ kind: 'completion_stuck', ...base, message: `${c.number}: signed, but storing documents / sending the welcome email has not finished.` });
    }
  }
  return alerts;
}

/**
 * Lot card / lot page summary of a contract (pure). `documents` are
 * ContractDocument rows without data; `events` the latest ContractEvents.
 */
function contractSummary(c, { documents = [], events = [], openPayment = null, now = new Date() } = {}) {
  if (!c) return null;
  const b = c.billing || {};
  const actions = {};
  for (const [name, guard] of Object.entries(ACTION_GUARDS)) {
    try {
      actions[name] = Boolean(guard(c));
    } catch {
      actions[name] = false;
    }
  }
  return {
    _id: c._id,
    number: c.number || '',
    status: c.status || 'draft',
    needsAttention: c.needsAttention || '',
    signingMode: c.signingMode || 'remote',
    package: c.package || null,
    pricing: c.pricing || null,
    signedAt: c.signedAt || null,
    purchasers: (c.purchasers || []).map((p) => ({
      role: p.role,
      name: p.name || '',
      email: p.email || '',
      signs: p.signs !== false,
      recipientId: p.recipientId || '',
      signStatus: p.signStatus || '',
      signedAt: p.signedAt || null,
      inPerson: Boolean(p.clientUserId),
    })),
    envelope: {
      status: (c.envelope && c.envelope.status) || null,
      sentAt: (c.envelope && c.envelope.sentAt) || null,
      completedAt: (c.envelope && c.envelope.completedAt) || null,
      declinedReason: (c.envelope && c.envelope.declinedReason) || '',
      voidedReason: (c.envelope && c.envelope.voidedReason) || '',
      lastSyncedAt: (c.envelope && c.envelope.lastSyncedAt) || null,
    },
    billing: {
      status: b.status || 'none',
      startedAt: b.startedAt || null,
      currentPeriodEnd: b.currentPeriodEnd || null,
      cancelAtPeriodEnd: Boolean(b.cancelAtPeriodEnd),
      pmBrand: b.pmBrand || '',
      pmLast4: b.pmLast4 || '',
      paidCount: b.paidCount || 0,
      totalPaidCents: b.totalPaidCents || 0,
      missedCount: b.missedCount || 0,
      missedOpenCents: b.missedOpenCents || 0,
      consecutiveMissed: b.consecutiveMissed || 0,
      // Past-due strip: why the last charge failed and when Stripe retries
      // (from the newest open invoice, when the caller passes it).
      lastFailureMessage: (openPayment && openPayment.failureMessage) || b.lastFailureMessage || '',
      nextPaymentAttempt: (openPayment && openPayment.nextPaymentAttempt) || null,
    },
    nextChargeAt: nextChargeFor(c),
    monthsActive: monthsActiveFor(c, now),
    reminders: { enabled: !(c.reminders && c.reminders.enabled === false) },
    invoiceEmails: { enabled: !(c.invoiceEmails && c.invoiceEmails.enabled === false) },
    portal: c.portal || {},
    documents: documents.map((d) => ({
      _id: d._id,
      kind: d.kind,
      source: d.source,
      filename: d.filename,
      size: d.size,
      sha256: d.sha256,
      createdAt: d.createdAt,
    })),
    events: events.map((e) => ({ _id: e._id, type: e.type, actor: e.actor, actorName: e.actorName, message: e.message, createdAt: e.createdAt })),
    actions,
    createdAt: c.createdAt || null,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function projectMatch(projectIds) {
  const ids = toList(projectIds).filter((p) => mongoose.isValidObjectId(p));
  if (!ids.length) return {};
  return { project: { $in: ids.map((p) => new mongoose.Types.ObjectId(p)) } };
}

// Contract ids for payment queries scoped to projects (payments carry no
// project of their own). null = no scoping.
async function contractIdsFor(projectIds) {
  const m = projectMatch(projectIds);
  if (!m.project) return null;
  const rows = await AlarmContract.find(m).select('_id').lean();
  return rows.map((r) => r._id);
}

/**
 * @param {{projectIds?: string[], from?: Date, to?: Date}} [f]
 * @returns {Promise<{
 *   counts: Record<'draft'|'sent'|'declined'|'voided'|'awaiting_payment'|'active'|'past_due'|'unpaid'|'canceled', number> & {needsAttention: number, total: number},
 *   mrrCents: number, mrrInclTaxCents: number,
 *   collectedCents: number, collectedTaxCents: number,
 *   missed: {count: number, cents: number, contracts: Array<{_id, number, lotNumber, projectName, missedCount, consecutiveMissed, missedOpenCents, nextPaymentAttempt}>},
 *   avgMonthsActive: number,
 *   awaitingSignature: {count: number, oldestDays: number},
 *   awaitingPayment: {count: number, staleCount: number},   // stale = signed > 7 days ago
 *   upcoming7d: {count: number, cents: number},
 *   packageMix: {basic: number, smart: number},
 *   byProject: Array<{projectId, name, active: number, total: number, mrrCents: number}>,
 *   chart: Array<{month: 'YYYY-MM', paidCents: number, paidCount: number, failedCents: number, failedCount: number}>, // 12 months
 *   alerts: Array<{kind: 'package_missing'|'amount_mismatch'|'card_expiring'|'completion_stuck'|'webhook_failed', contractId?, number?, message: string}>,
 *   testMode: boolean
 * }>}
 */
async function summary(f = {}) {
  const now = new Date();
  const from = toDate(f.from);
  const to = toDate(f.to);
  const scope = projectMatch(f.projectIds);
  const contractIds = await contractIdsFor(f.projectIds);
  const payScope = contractIds ? { contract: { $in: contractIds } } : {};

  const paidRange = {};
  if (from) paidRange.$gte = from;
  if (to) paidRange.$lte = to;
  const chartStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const [contracts, collectedRows, missedRows, chartRows, mismatched, failedWebhooks, projects] = await Promise.all([
    AlarmContract.find({ isCurrent: true, ...scope }).select(ROW_FIELDS).lean(),
    ContractPayment.aggregate([
      { $match: { status: 'paid', ...payScope, ...(from || to ? { paidAt: paidRange } : {}) } },
      {
        $group: {
          _id: null,
          cents: { $sum: { $subtract: ['$amountPaidCents', { $ifNull: ['$amountRefundedCents', 0] }] } },
          tax: { $sum: '$taxCents' },
        },
      },
    ]),
    ContractPayment.aggregate([
      { $match: { missed: true, ...payScope } },
      {
        $group: {
          _id: '$contract',
          count: { $sum: 1 },
          cents: { $sum: '$amountRemainingCents' },
          nextPaymentAttempt: { $min: '$nextPaymentAttempt' },
        },
      },
    ]),
    // Paid by paidAt month; failed = invoices with a failed attempt that are
    // still owing or written off, by invoice month.
    ContractPayment.aggregate([
      {
        $match: {
          ...payScope,
          $or: [
            { status: 'paid', paidAt: { $gte: chartStart } },
            { missed: true, invoiceCreatedAt: { $gte: chartStart } },
          ],
        },
      },
      {
        $project: {
          kind: { $cond: [{ $eq: ['$status', 'paid'] }, 'paid', 'failed'] },
          at: { $cond: [{ $eq: ['$status', 'paid'] }, '$paidAt', '$invoiceCreatedAt'] },
          cents: {
            $cond: [
              { $eq: ['$status', 'paid'] },
              { $subtract: ['$amountPaidCents', { $ifNull: ['$amountRefundedCents', 0] }] },
              '$amountRemainingCents',
            ],
          },
        },
      },
      {
        $group: {
          _id: { kind: '$kind', month: { $dateToString: { format: '%Y-%m', date: '$at', timezone: 'UTC' } } },
          cents: { $sum: '$cents' },
          count: { $sum: 1 },
        },
      },
    ]),
    ContractPayment.find({ amountMismatch: true, status: { $ne: 'void' }, ...payScope })
      .select('contract number totalCents')
      .sort({ createdAt: -1 })
      .limit(ALERT_LIMIT)
      .lean(),
    WebhookEvent.countDocuments({ status: 'failed' }),
    Project.find({}).select('name').lean(),
  ]);

  const projectNames = new Map(projects.map((p) => [String(p._id), p.name || '']));
  const base = computeSummary(contracts, { now, projectNames });
  const byId = new Map(contracts.map((c) => [String(c._id), c]));

  // Missed contracts list: current contracts first, others looked up.
  const missedIdsUnknown = missedRows.map((r) => r._id).filter((id) => !byId.has(String(id)));
  if (missedIdsUnknown.length) {
    const extra = await AlarmContract.find({ _id: { $in: missedIdsUnknown } }).select(ROW_FIELDS).lean();
    for (const c of extra) byId.set(String(c._id), c);
  }
  const missedContracts = missedRows
    .map((r) => {
      const c = byId.get(String(r._id)) || {};
      const b = c.billing || {};
      return {
        _id: r._id,
        number: c.number || '',
        lotNumber: (c.property && c.property.lotNumber) || '',
        projectName: projectNames.get(idStr(c.project)) || (c.property && c.property.projectName) || '',
        missedCount: r.count,
        consecutiveMissed: b.consecutiveMissed || 0,
        missedOpenCents: r.cents || 0,
        nextPaymentAttempt: r.nextPaymentAttempt || null,
      };
    })
    .sort((a, b) => b.consecutiveMissed - a.consecutiveMissed || b.missedOpenCents - a.missedOpenCents);

  const alerts = contractAlerts(contracts, now);
  if (mismatched.length) {
    const numbers = await AlarmContract.find({ _id: { $in: mismatched.map((p) => p.contract) } }).select('number').lean();
    const num = new Map(numbers.map((c) => [String(c._id), c.number]));
    for (const p of mismatched) {
      const n = num.get(String(p.contract)) || '';
      alerts.push({
        kind: 'amount_mismatch',
        contractId: p.contract,
        number: n,
        message: `${n}: invoice ${p.number || ''} total ${dollars(p.totalCents)} differs from the contract price.`,
      });
    }
  }
  if (failedWebhooks) {
    alerts.push({
      kind: 'webhook_failed',
      message: `${failedWebhooks} webhook event${failedWebhooks === 1 ? '' : 's'} failed to process; the reconciler retries them.`,
    });
  }

  const collected = collectedRows[0] || {};
  return {
    ...base,
    collectedCents: collected.cents || 0,
    collectedTaxCents: collected.tax || 0,
    missed: {
      count: missedRows.reduce((n, r) => n + r.count, 0),
      cents: missedRows.reduce((n, r) => n + (r.cents || 0), 0),
      contracts: missedContracts,
    },
    chart: buildChart(
      chartRows.map((r) => ({ month: r._id.month, kind: r._id.kind, cents: r.cents, count: r.count })),
      now
    ),
    alerts: alerts.slice(0, ALERT_LIMIT),
    testMode: env.stripe.mode === 'test',
  };
}

/**
 * Server-paged table rows.
 * @param {{status?: string|string[], project?: string|string[], q?: string, due?: '7d', reminders?: 'on'|'off',
 *   needsAttention?: '1', missed?: '1', current?: '0'|'1', page?: number, limit?: number, sort?: string}} f
 * @returns {Promise<{items: Array<ContractRow>, total: number, page: number, pages: number, limit: number}>}
 *
 * ContractRow = { _id, number, status, needsAttention, signingMode,
 *   purchasers: [{name, email}], project: {_id, name}, lot: {_id, lotNumber},
 *   package, unitCents, totalCents, signedAt, startedAt, monthsActive,
 *   paidCount, totalPaidCents, missedCount, missedOpenCents, consecutiveMissed,
 *   nextChargeAt, remindersEnabled, invoiceEmailsEnabled, createdAt }
 *   (+ isCurrent, cancelAtPeriodEnd)
 */
async function listRows(f = {}) {
  const now = new Date();
  const filter = buildListFilter(f, now);
  const { limit, page, skip } = pageParams(f);
  const [docs, total] = await Promise.all([
    AlarmContract.find(filter)
      .select(ROW_FIELDS)
      .sort(sortSpec(f.sort))
      .skip(skip)
      .limit(limit)
      .populate('project', 'name')
      .populate('lot', 'lotNumber')
      .lean(),
    AlarmContract.countDocuments(filter),
  ]);
  return {
    items: docs.map((c) => toRow(c, now)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  };
}

/**
 * Same filters as listRows, every page, as CSV text (header row first).
 * @returns {Promise<string>}
 */
async function exportCsv(f = {}) {
  const now = new Date();
  const docs = await AlarmContract.find(buildListFilter(f, now))
    .select(ROW_FIELDS)
    .sort(sortSpec(f.sort))
    .limit(20000)
    .populate('project', 'name')
    .populate('lot', 'lotNumber')
    .lean();
  return rowsToCsv(docs.map((c) => toRow(c, now)));
}

/**
 * Small block for the main Dashboard. @returns {Promise<{active: number, mrrCents: number, pastDue: number}>}
 */
async function dashboardBlock() {
  const rows = await AlarmContract.aggregate([
    { $match: { isCurrent: true, status: { $in: BILLING_LIVE } } },
    { $group: { _id: '$status', n: { $sum: 1 }, mrr: { $sum: { $ifNull: ['$pricing.unitCents', 0] } } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  return {
    active: (by.active && by.active.n) || 0,
    mrrCents: rows.reduce((n, r) => n + (r.mrr || 0), 0),
    pastDue: ((by.past_due && by.past_due.n) || 0) + ((by.unpaid && by.unpaid.n) || 0),
  };
}

module.exports = {
  summary,
  listRows,
  exportCsv,
  dashboardBlock,
  // pure helpers (routes + tests)
  parseDateOnly,
  toList,
  monthKey,
  monthKeys,
  buildChart,
  monthsActiveFor,
  nextChargeFor,
  primaryPurchaser,
  toRow,
  buildListFilter,
  sortSpec,
  pageParams,
  csvCell,
  rowsToCsv,
  computeSummary,
  contractAlerts,
  contractSummary,
  ROW_FIELDS,
};

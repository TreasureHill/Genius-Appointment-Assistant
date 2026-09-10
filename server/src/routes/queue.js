const express = require('express');
const Outbox = require('../models/Outbox');
const MessageLog = require('../models/MessageLog');
const Setting = require('../models/Setting');
const callQueue = require('../services/callQueue');
const senderWorker = require('../workers/senderWorker');
const { replanPendingOutbox, scheduleStatus } = require('../services/outboxPlanner');
const { resolveScheduleTimezone, startOfDayInTimezone } = require('../services/sendWindow');
const { GROUP_KEY_EXPR, groupKeyOf } = require('../services/sendGroups');

// The Queue tab: every email / SMS waiting in the outbox and every Aria call
// waiting in the call queue, with the exact time each goes out (in the
// schedule's timezone) and the controls to cancel, force, or re-plan them.
//
// The lot is the unit: one queue item per lot × channel (a "send"), even when
// that send is several texts to several phones. Items carry the ids of every
// underlying row so cancel / send-now act on the whole send.
const router = express.Router();

const LIVE = ['pending', 'sending'];
const MAX_ROWS = 2000;

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Why a pending row won't go out even though its time has come.
function holdReason(row, project, setting) {
  if (setting.senderPaused) return 'sender_paused';
  if (row.sendNow || !row.isReminder) return '';
  if (setting.remindersPaused) return 'reminders_paused';
  if (project && project.remindersPaused) return 'project_reminders_paused';
  return '';
}

function rowRecipients(r, lot) {
  if (Array.isArray(r.recipients) && r.recipients.length) {
    return r.recipients.map((x) => ({ buyerIndex: x.buyerIndex, role: x.role || '', name: x.name || '', address: x.address || '' }));
  }
  const buyer = lot && Array.isArray(lot.buyers) ? lot.buyers[r.buyerIndex] || null : null;
  return [{ buyerIndex: r.buyerIndex, role: buyer?.role || '', name: buyer?.name || '', address: r.to || '' }];
}

function shapeRow(r, setting) {
  const lot = r.lot && typeof r.lot === 'object' ? r.lot : null;
  const project = r.project && typeof r.project === 'object' ? r.project : null;
  const template = r.templateId && typeof r.templateId === 'object' ? r.templateId : null;
  const bodyText = r.type === 'email' ? stripHtml(r.renderedBody) : String(r.renderedBody || '');
  return {
    _id: r._id,
    key: groupKeyOf(r),
    ids: [String(r._id)],
    rows: 1,
    type: r.type,
    status: r.status,
    sendAfter: r.sendAfter,
    sendNow: !!r.sendNow,
    isReminder: !!r.isReminder,
    reminderIndex: r.reminderIndex || 0,
    attempts: r.attempts || 0,
    lastError: r.lastError || '',
    createdAt: r.createdAt,
    to: r.to,
    recipients: rowRecipients(r, lot),
    subject: r.renderedSubject || '',
    preview: bodyText.slice(0, 180),
    project: project ? { _id: project._id, name: project.name, remindersPaused: !!project.remindersPaused } : null,
    lot: lot
      ? { _id: lot._id, lotNumber: lot.lotNumber, address: lot.address || '', status: lot.status }
      : { _id: r.lot, lotNumber: '', address: '', deleted: true },
    template: template ? { _id: template._id, name: template.name } : null,
    hold: holdReason(r, project, setting),
  };
}

// Fold rows into one item per send group (rows arrive sorted by sendAfter, so
// groups come out in send order too).
function groupRows(rows, setting) {
  const out = [];
  const byKey = new Map();
  for (const r of rows) {
    const shaped = shapeRow(r, setting);
    const g = byKey.get(shaped.key);
    if (!g) {
      byKey.set(shaped.key, shaped);
      out.push(shaped);
      continue;
    }
    g.ids.push(...shaped.ids);
    g.rows += 1;
    g.recipients.push(...shaped.recipients);
    g.to = g.recipients.map((x) => x.address).join(', ');
    if (shaped.status === 'sending') g.status = 'sending';
    if (new Date(shaped.sendAfter) < new Date(g.sendAfter)) g.sendAfter = shaped.sendAfter;
    g.sendNow = g.sendNow && shaped.sendNow;
    g.attempts = Math.max(g.attempts, shaped.attempts);
    if (!g.lastError && shaped.lastError) g.lastError = shaped.lastError;
    if (!g.hold && shaped.hold) g.hold = shaped.hold;
  }
  return out;
}

const populateAll = (q) =>
  q
    .populate('project', 'name remindersPaused')
    .populate('lot', 'lotNumber address buyers status')
    .populate('templateId', 'name');

// Distinct sends (groups) per type among live rows, plus raw row counts.
async function liveCounts() {
  const rows = await Outbox.aggregate([
    { $match: { status: { $in: LIVE } } },
    {
      $group: {
        _id: { type: '$type', g: GROUP_KEY_EXPR },
        rows: { $sum: 1 },
        sending: { $max: { $cond: [{ $eq: ['$status', 'sending'] }, 1, 0] } },
      },
    },
    { $group: { _id: '$_id.type', sends: { $sum: 1 }, rows: { $sum: '$rows' }, sending: { $sum: '$sending' } } },
  ]);
  const counts = { email: 0, sms: 0, total: 0, sending: 0, rows: { email: 0, sms: 0 } };
  for (const c of rows) {
    counts[c._id] = c.sends;
    counts.rows[c._id] = c.rows;
    counts.total += c.sends;
    counts.sending += c.sending;
  }
  return counts;
}

// Sends (not rows) logged since `since`, by type and by status.
async function sentCounts(since) {
  const rows = await MessageLog.aggregate([
    { $match: { direction: 'out', type: { $in: ['email', 'sms', 'call'] }, createdAt: { $gte: since } } },
    { $group: { _id: { type: '$type', status: '$status', g: GROUP_KEY_EXPR } } },
    { $group: { _id: { type: '$_id.type', status: '$_id.status' }, n: { $sum: 1 } } },
  ]);
  const out = { email: 0, sms: 0, calls: 0, failed: 0 };
  for (const r of rows) {
    const { type, status } = r._id;
    if (type === 'call') out.calls += r.n;
    else if (status === 'failed') out.failed += r.n;
    else if (status === 'sent') out[type] += r.n;
  }
  return out;
}

router.get('/', async (req, res) => {
  const { project, type, lot } = req.query;
  const setting = await Setting.getSingleton();
  const timezone = resolveScheduleTimezone(setting);
  const now = new Date();
  const dayStart = startOfDayInTimezone(now, timezone);

  const filter = { status: { $in: LIVE } };
  if (project) filter.project = project;
  if (lot) filter.lot = lot;
  if (type === 'email' || type === 'sms') filter.type = type;

  const [rows, counts, nextRow, calls, today, schedule] = await Promise.all([
    populateAll(Outbox.find(filter)).sort({ sendAfter: 1, sendGroup: 1, _id: 1 }).limit(MAX_ROWS).lean(),
    liveCounts(),
    Outbox.findOne({ status: 'pending' }).sort({ sendAfter: 1 }).select('sendAfter type').lean(),
    callQueue.getStatus(),
    sentCounts(dayStart),
    scheduleStatus(setting),
  ]);

  const items = groupRows(rows, setting);

  res.json({
    timezone,
    now: now.toISOString(),
    schedule,
    counts: { ...counts, held: items.filter((i) => i.hold).length },
    emailPerLot: setting.schedule?.emailPerLot !== false,
    nextSendAt: nextRow ? nextRow.sendAfter : null,
    items,
    truncated: rows.length >= MAX_ROWS,
    calls,
    today,
  });
});

// Full detail (rendered body) for one queued row.
router.get('/:id', async (req, res) => {
  const r = await populateAll(Outbox.findById(req.params.id)).lean();
  if (!r) return res.status(404).json({ error: 'not_found' });
  const setting = await Setting.getSingleton();
  res.json({
    ...shapeRow(r, setting),
    body: r.renderedBody || '',
    text: r.renderedText || '',
    bodyText: r.type === 'email' ? stripHtml(r.renderedBody) : String(r.renderedBody || ''),
  });
});

function kick() {
  // Kick the worker so a forced send goes out in seconds, not on the next
  // 10 s poll.
  senderWorker.drainOnce().catch(() => {});
}

// Force messages out on the next worker tick: skips the send window and any
// reminder hold. Only "Pause sending" still stops them.
router.post('/send-now', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids_required' });
  const r = await Outbox.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { sendAfter: new Date(), sendNow: true } });
  if (r.modifiedCount) kick();
  res.json({ ok: true, forced: r.modifiedCount || 0 });
});

router.post('/:id/send-now', async (req, res) => {
  const row = await Outbox.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { sendAfter: new Date(), sendNow: true } },
    { new: true }
  );
  if (!row) return res.status(400).json({ error: 'not_pending' });
  kick();
  res.json({ ok: true, id: row._id, sendAfter: row.sendAfter });
});

router.post('/:id/cancel', async (req, res) => {
  const row = await Outbox.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { status: 'cancelled', lastError: 'cancelled by user' } },
    { new: true }
  );
  if (!row) return res.status(400).json({ error: 'not_pending' });
  res.json({ ok: true, id: row._id });
});

router.post('/cancel', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids_required' });
  const r = await Outbox.updateMany(
    { _id: { $in: ids }, status: 'pending' },
    { $set: { status: 'cancelled', lastError: 'cancelled by user' } }
  );
  res.json({ ok: true, cancelled: r.modifiedCount || 0 });
});

// Cancel every pending message, optionally narrowed to a project and/or type.
router.post('/cancel-all', async (req, res) => {
  const { project, type } = req.body || {};
  const filter = { status: 'pending' };
  if (project) filter.project = project;
  if (type === 'email' || type === 'sms') filter.type = type;
  const r = await Outbox.updateMany(filter, {
    $set: { status: 'cancelled', lastError: 'cancelled by user (cancel all)' },
  });
  res.json({ ok: true, cancelled: r.modifiedCount || 0 });
});

// Re-plan everything pending from now: same order, fresh pacing, inside the
// current send windows + timezone.
router.post('/replan', async (req, res) => {
  const r = await replanPendingOutbox();
  res.json({ ok: true, ...r });
});

module.exports = router;

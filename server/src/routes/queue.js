const express = require('express');
const Outbox = require('../models/Outbox');
const MessageLog = require('../models/MessageLog');
const Setting = require('../models/Setting');
const callQueue = require('../services/callQueue');
const senderWorker = require('../workers/senderWorker');
const { replanPendingOutbox, scheduleStatus } = require('../services/outboxPlanner');
const { resolveScheduleTimezone, startOfDayInTimezone } = require('../services/sendWindow');

// The Queue tab: every email / SMS waiting in the outbox and every Aria call
// waiting in the call queue, with the exact time each goes out (in the
// schedule's timezone) and the controls to cancel, force, or re-plan them.
const router = express.Router();

const LIVE = ['pending', 'sending'];
const MAX_ROWS = 1000;

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

function shapeRow(r, setting) {
  const lot = r.lot && typeof r.lot === 'object' ? r.lot : null;
  const project = r.project && typeof r.project === 'object' ? r.project : null;
  const buyer = lot && Array.isArray(lot.buyers) ? lot.buyers[r.buyerIndex] || null : null;
  const template = r.templateId && typeof r.templateId === 'object' ? r.templateId : null;
  const bodyText = r.type === 'email' ? stripHtml(r.renderedBody) : String(r.renderedBody || '');
  return {
    _id: r._id,
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
    subject: r.renderedSubject || '',
    preview: bodyText.slice(0, 180),
    project: project ? { _id: project._id, name: project.name, remindersPaused: !!project.remindersPaused } : null,
    lot: lot
      ? { _id: lot._id, lotNumber: lot.lotNumber, address: lot.address || '', status: lot.status }
      : { _id: r.lot, lotNumber: '', address: '', deleted: true },
    buyer: buyer ? { name: buyer.name || '', role: buyer.role || '' } : null,
    template: template ? { _id: template._id, name: template.name } : null,
    hold: holdReason(r, project, setting),
  };
}

const populateAll = (q) =>
  q
    .populate('project', 'name remindersPaused')
    .populate('lot', 'lotNumber address buyers status')
    .populate('templateId', 'name');

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

  const [rows, liveCounts, nextRow, calls, sentToday, failedToday, callsToday, schedule] = await Promise.all([
    populateAll(Outbox.find(filter)).sort({ sendAfter: 1, _id: 1 }).limit(MAX_ROWS).lean(),
    Outbox.aggregate([
      { $match: { status: { $in: LIVE } } },
      { $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } },
    ]),
    Outbox.findOne({ status: 'pending' }).sort({ sendAfter: 1 }).select('sendAfter type').lean(),
    callQueue.getStatus(),
    MessageLog.aggregate([
      {
        $match: {
          direction: 'out',
          status: 'sent',
          type: { $in: ['email', 'sms'] },
          createdAt: { $gte: dayStart },
        },
      },
      { $group: { _id: '$type', n: { $sum: 1 } } },
    ]),
    MessageLog.countDocuments({
      direction: 'out',
      status: 'failed',
      type: { $in: ['email', 'sms'] },
      createdAt: { $gte: dayStart },
    }),
    MessageLog.countDocuments({ type: 'call', direction: 'out', createdAt: { $gte: dayStart } }),
    scheduleStatus(setting),
  ]);

  const counts = { email: 0, sms: 0, sending: 0, total: 0 };
  for (const c of liveCounts) {
    const t = c._id.type;
    if (counts[t] == null) counts[t] = 0;
    counts[t] += c.n;
    counts.total += c.n;
    if (c._id.status === 'sending') counts.sending += c.n;
  }
  const items = rows.map((r) => shapeRow(r, setting));
  const today = { email: 0, sms: 0, failed: failedToday, calls: callsToday };
  for (const s of sentToday) today[s._id] = s.n;

  res.json({
    timezone,
    now: now.toISOString(),
    schedule,
    counts: { ...counts, held: items.filter((i) => i.hold).length },
    nextSendAt: nextRow ? nextRow.sendAfter : null,
    items,
    truncated: rows.length >= MAX_ROWS,
    calls,
    today,
  });
});

// Full detail (rendered body) for one queued message.
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

// Force one message out on the next worker tick: skips the send window and
// any reminder hold. Only "Pause sending" still stops it.
router.post('/:id/send-now', async (req, res) => {
  const row = await Outbox.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { sendAfter: new Date(), sendNow: true } },
    { new: true }
  );
  if (!row) return res.status(400).json({ error: 'not_pending' });
  // Kick the worker so it goes out in seconds, not on the next 10 s poll.
  senderWorker.drainOnce().catch(() => {});
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

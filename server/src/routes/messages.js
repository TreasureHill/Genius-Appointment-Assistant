const express = require('express');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const { enqueueBroadcast, bumpReminderCount, queueTail } = require('../services/enqueue');
const { scheduleStatus } = require('../services/outboxPlanner');
const { resolveDefaultsForProject } = require('../services/templateResolver');

const router = express.Router();

router.get('/history', async (req, res) => {
  const { project, lot, type, direction, status, q } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 25));

  const filter = {};
  if (project) filter.project = project;
  if (lot) filter.lot = lot;
  if (type) filter.type = type;
  if (direction) filter.direction = direction;
  if (status) filter.status = status;
  if (q) {
    const r = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ to: r }, { subject: r }, { body: r }, { error: r }];
  }

  const [items, total] = await Promise.all([
    MessageLog.find(filter)
      .populate('project', 'name')
      .populate('lot', 'lotNumber address')
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    MessageLog.countDocuments(filter),
  ]);

  res.json({
    items,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

router.get('/outbox', async (req, res) => {
  const { project, lot, status = 'pending', limit = 200 } = req.query;
  const filter = {};
  if (project) filter.project = project;
  if (lot) filter.lot = lot;
  if (status) filter.status = status;
  const rows = await Outbox.find(filter)
    .populate('project', 'name')
    .populate('lot', 'lotNumber')
    .sort({ sendAfter: 1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();
  res.json(rows);
});

router.post('/send', async (req, res) => {
  const { lotIds, templateId } = req.body || {};
  if (!Array.isArray(lotIds) || lotIds.length === 0) return res.status(400).json({ error: 'lotIds_required' });
  if (!templateId) return res.status(400).json({ error: 'templateId_required' });
  // Pace on after whatever is already queued (one global line).
  const result = await enqueueBroadcast({ lotIds, templateId, startAt: await queueTail() });
  await bumpReminderCount(result.touchedLotIds);
  res.json({ ...result, schedule: await scheduleStatus() });
});

// "Send defaults" — fires both the default email AND default SMS templates at
// every selected lot. Templates resolve per project: project-level default
// (set on the project page) takes priority, then system-wide Setting default,
// then the isDefaultReminder fallback. Pacing applies across the combined
// queue so email+SMS don't blast at once.
// Filter:
//   - { lotIds: [...] } sends to those specific lots (grouped by project for resolution)
//   - { projectId: '...', onlyPending: true } sends to every pending lot in a
//     project (skipping contacted / scheduled / completed / opted_out automatically)
router.post('/send-defaults', async (req, res) => {
  const { lotIds, projectId, onlyPending = false } = req.body || {};

  // Gather target lots together with their project ids so we can resolve
  // templates per-project.
  let targetLots = [];
  if (Array.isArray(lotIds) && lotIds.length) {
    targetLots = await Lot.find({ _id: { $in: lotIds } }).select('_id project').lean();
  } else if (projectId) {
    const filter = { project: projectId };
    if (onlyPending) filter.status = 'pending';
    targetLots = await Lot.find(filter).select('_id project').lean();
  } else {
    return res.status(400).json({ error: 'lotIds_or_projectId_required' });
  }
  if (!targetLots.length) return res.json({ queued: [], skipped: [], note: 'no lots matched' });

  // Group lots by their project id so each project picks up its own defaults.
  const byProject = new Map();
  for (const l of targetLots) {
    const pid = String(l.project);
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(l._id);
  }

  const queued = [];
  const sends = [];
  const skipped = [];
  const touched = new Set();
  const usedByProject = {};
  const usedEmailById = new Map();
  const usedSmsById = new Map();
  let anyTemplateFound = false;
  let firstSendAt = null;
  let lastSendAt = null;
  let timezone = null;
  let emailPerLot = true;
  // One paced line: this batch starts after whatever is already queued, and
  // email → SMS → next project chain instead of all starting "now".
  let cursor = await queueTail();

  const take = (r) => {
    queued.push(...r.queued);
    sends.push(...(r.sends || []));
    skipped.push(...r.skipped);
    emailPerLot = r.emailPerLot !== false;
    for (const id of r.touchedLotIds) touched.add(id);
    if (r.firstSendAt && (!firstSendAt || r.firstSendAt < firstSendAt)) firstSendAt = r.firstSendAt;
    if (r.lastSendAt && (!lastSendAt || r.lastSendAt > lastSendAt)) lastSendAt = r.lastSendAt;
    timezone = r.timezone;
    cursor = r.nextCursor;
  };

  for (const [pid, ids] of byProject) {
    const { emailTpl, smsTpl, sources } = await resolveDefaultsForProject(pid);
    if (!emailTpl && !smsTpl) {
      for (const id of ids) skipped.push({ lotId: String(id), reason: 'no default templates for project' });
      continue;
    }
    anyTemplateFound = true;
    usedByProject[pid] = {
      email: emailTpl ? { id: String(emailTpl._id), name: emailTpl.name, source: sources.email } : null,
      sms: smsTpl ? { id: String(smsTpl._id), name: smsTpl.name, source: sources.sms } : null,
    };
    if (emailTpl) {
      usedEmailById.set(String(emailTpl._id), { id: String(emailTpl._id), name: emailTpl.name });
      take(await enqueueBroadcast({ lotIds: ids, templateId: emailTpl._id, startAt: cursor }));
    }
    if (smsTpl) {
      usedSmsById.set(String(smsTpl._id), { id: String(smsTpl._id), name: smsTpl.name });
      take(await enqueueBroadcast({ lotIds: ids, templateId: smsTpl._id, startAt: cursor }));
    }
  }

  if (!anyTemplateFound) {
    return res
      .status(400)
      .json({ error: 'no_default_templates', message: 'Set default email + SMS templates in Settings or on the project first.' });
  }

  // Single bump per lot per user action — email + SMS in one click counts as
  // ONE reminder for the lot, not two.
  await bumpReminderCount(Array.from(touched));
  res.json({
    // `queued` has one entry per row written (per recipient for texts);
    // `sends` has one per lot × channel — the number the UI reports.
    queued,
    sends,
    sendCount: sends.length,
    emailPerLot,
    skipped,
    skipSummary: summarizeSkips(skipped),
    touchedLots: touched.size,
    // Flat "which templates fired" view for the UI. When several projects
    // resolve to different templates the names are joined so the message
    // still names every template that went out.
    usedEmail: describeUsed(usedEmailById),
    usedSms: describeUsed(usedSmsById),
    usedByProject,
    // When the batch actually goes out (send window + pacing applied), so the
    // Board can say "first at 9:00 AM Fri, last at 9:41 AM" and link the Queue.
    firstSendAt,
    lastSendAt,
    timezone,
    schedule: await scheduleStatus(),
  });
});

// Collapse per-buyer skip rows into { reason: count } buckets so the UI can
// explain *why* nothing queued (max reminders reached, lot already scheduled,
// buyer missing an email, ...) instead of guessing.
function summarizeSkips(skipped) {
  const counts = {};
  for (const s of skipped) {
    const key = normalizeSkipReason(s.reason);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeSkipReason(reason) {
  const r = String(reason || '');
  if (r.startsWith('max reminders reached')) return 'max_reminders_reached';
  if (r.startsWith('status=')) return `status_${r.slice('status='.length)}`;
  if (r.includes('opted out')) return 'opted_out';
  if (r.includes('missing email')) return 'missing_email';
  if (r.includes('missing sms')) return 'missing_phone';
  if (r.includes('duplicate')) return 'duplicate_contact';
  if (r.startsWith('no default templates')) return 'no_default_templates';
  return r || 'unknown';
}

function describeUsed(byId) {
  if (byId.size === 0) return null;
  const list = Array.from(byId.values());
  if (list.length === 1) return list[0];
  return { id: list[0].id, name: list.map((t) => t.name).join(' / '), all: list };
}

router.post('/outbox/:id/cancel', async (req, res) => {
  const row = await Outbox.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'not_pending' });
  row.status = 'cancelled';
  row.lastError = 'cancelled by user';
  await row.save();
  res.json(row);
});

module.exports = router;

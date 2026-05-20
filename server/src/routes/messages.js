const express = require('express');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const { enqueueBroadcast, bumpReminderCount } = require('../services/enqueue');
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
  const result = await enqueueBroadcast({ lotIds, templateId });
  await bumpReminderCount(result.touchedLotIds);
  res.json(result);
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
  const skipped = [];
  const touched = new Set();
  const usedByProject = {};
  let anyTemplateFound = false;

  for (const [pid, ids] of byProject) {
    const { emailTpl, smsTpl } = await resolveDefaultsForProject(pid);
    if (!emailTpl && !smsTpl) continue;
    anyTemplateFound = true;
    usedByProject[pid] = {
      email: emailTpl ? { id: String(emailTpl._id), name: emailTpl.name } : null,
      sms: smsTpl ? { id: String(smsTpl._id), name: smsTpl.name } : null,
    };
    if (emailTpl) {
      const r = await enqueueBroadcast({ lotIds: ids, templateId: emailTpl._id });
      queued.push(...r.queued);
      skipped.push(...r.skipped);
      for (const id of r.touchedLotIds) touched.add(id);
    }
    if (smsTpl) {
      const r = await enqueueBroadcast({ lotIds: ids, templateId: smsTpl._id });
      queued.push(...r.queued);
      skipped.push(...r.skipped);
      for (const id of r.touchedLotIds) touched.add(id);
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
    queued,
    skipped,
    touchedLots: touched.size,
    usedByProject,
  });
});

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

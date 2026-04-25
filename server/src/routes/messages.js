const express = require('express');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Setting = require('../models/Setting');
const Template = require('../models/Template');
const Lot = require('../models/Lot');
const { enqueueBroadcast } = require('../services/enqueue');

const router = express.Router();

router.get('/history', async (req, res) => {
  const { project, lot, type, direction, status, limit = 200 } = req.query;
  const filter = {};
  if (project) filter.project = project;
  if (lot) filter.lot = lot;
  if (type) filter.type = type;
  if (direction) filter.direction = direction;
  if (status) filter.status = status;
  const logs = await MessageLog.find(filter)
    .populate('project', 'name')
    .populate('lot', 'lotNumber address')
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();
  res.json(logs);
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
  res.json(result);
});

// "Send defaults" — fires both the default email AND default SMS templates
// (configured under Settings → Sending schedule) at every selected lot.
// Pacing applies across the combined queue so email+SMS don't blast at once.
// Filter:
//   - { lotIds: [...] } sends to those specific lots
//   - { projectId: '...', onlyPending: true } sends to every pending lot in
//     a project (skipping contacted / scheduled / opted_out automatically)
router.post('/send-defaults', async (req, res) => {
  const { lotIds, projectId, onlyPending = false } = req.body || {};

  const setting = await Setting.getSingleton();
  const sched = setting.schedule || {};
  let emailTpl = null;
  let smsTpl = null;
  if (sched.defaultEmailTemplate) emailTpl = await Template.findById(sched.defaultEmailTemplate);
  if (sched.defaultSmsTemplate) smsTpl = await Template.findById(sched.defaultSmsTemplate);
  if (!emailTpl) emailTpl = await Template.findOne({ type: 'email', isDefaultReminder: true });
  if (!smsTpl) smsTpl = await Template.findOne({ type: 'sms', isDefaultReminder: true });
  if (!emailTpl && !smsTpl) {
    return res
      .status(400)
      .json({ error: 'no_default_templates', message: 'Set default email + SMS templates in Settings first.' });
  }

  let targetLotIds = [];
  if (Array.isArray(lotIds) && lotIds.length) {
    targetLotIds = lotIds;
  } else if (projectId) {
    const filter = { project: projectId };
    if (onlyPending) filter.status = 'pending';
    const lots = await Lot.find(filter).select('_id').lean();
    targetLotIds = lots.map((l) => l._id);
  } else {
    return res.status(400).json({ error: 'lotIds_or_projectId_required' });
  }
  if (!targetLotIds.length) return res.json({ queued: [], skipped: [], note: 'no lots matched' });

  const queued = [];
  const skipped = [];
  if (emailTpl) {
    const r = await enqueueBroadcast({ lotIds: targetLotIds, templateId: emailTpl._id });
    queued.push(...r.queued);
    skipped.push(...r.skipped);
  }
  if (smsTpl) {
    const r = await enqueueBroadcast({ lotIds: targetLotIds, templateId: smsTpl._id });
    queued.push(...r.queued);
    skipped.push(...r.skipped);
  }
  res.json({
    queued,
    skipped,
    usedEmail: emailTpl ? { id: String(emailTpl._id), name: emailTpl.name } : null,
    usedSms: smsTpl ? { id: String(smsTpl._id), name: smsTpl.name } : null,
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

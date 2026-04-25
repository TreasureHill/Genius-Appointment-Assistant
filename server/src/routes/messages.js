const express = require('express');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
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

const express = require('express');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast } = require('../services/enqueue');

const router = express.Router();

router.get('/', async (req, res) => {
  const { project, status, q, limit = 200 } = req.query;
  const filter = {};
  if (project) filter.project = project;
  if (status) filter.status = status;
  if (q) {
    const r = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { lotNumber: r },
      { address: r },
      { 'buyers.name': r },
      { 'buyers.email': r },
      { 'buyers.phone': r },
    ];
  }
  const lots = await Lot.find(filter)
    .populate('project', 'name')
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();
  res.json(lots);
});

router.get('/:id', async (req, res) => {
  const lot = await Lot.findById(req.params.id).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });
  const history = await MessageLog.find({ lot: lot._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const queued = await Outbox.find({ lot: lot._id, status: { $in: ['pending', 'sending'] } })
    .sort({ sendAfter: 1 })
    .lean();
  res.json({ lot, history, queued });
});

router.post('/', async (req, res) => {
  const { project, lotNumber, address, buyers = [], status = 'pending', notes = '' } = req.body || {};
  if (!project || !lotNumber) return res.status(400).json({ error: 'project_and_lotNumber_required' });
  try {
    const lot = await Lot.create({ project, lotNumber, address, buyers, status, notes });
    res.status(201).json(lot);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'duplicate_lot_number' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const allowed = ['lotNumber', 'address', 'buyers', 'status', 'notes', 'reminderCount'];
  const update = {};
  for (const k of allowed) if (k in req.body) update[k] = req.body[k];
  const lot = await Lot.findByIdAndUpdate(req.params.id, update, { new: true }).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });

  // Cancel any pending outbox rows if lot is now stopped
  if (Lot.STOP_STATUSES.includes(lot.status)) {
    await Outbox.updateMany(
      { lot: lot._id, status: 'pending' },
      { $set: { status: 'cancelled', lastError: `lot status changed to ${lot.status}` } }
    );
  }
  res.json(lot);
});

router.post('/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!Lot.STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const lot = await Lot.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!lot) return res.status(404).json({ error: 'not_found' });
  if (Lot.STOP_STATUSES.includes(status)) {
    await Outbox.updateMany(
      { lot: lot._id, status: 'pending' },
      { $set: { status: 'cancelled', lastError: `lot status changed to ${status}` } }
    );
  }
  res.json(lot);
});

router.delete('/:id', async (req, res) => {
  const lot = await Lot.findByIdAndDelete(req.params.id);
  if (!lot) return res.status(404).json({ error: 'not_found' });
  await Outbox.deleteMany({ lot: lot._id });
  res.json({ ok: true });
});

router.post('/bulk-delete', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids_required' });
  }
  await Outbox.deleteMany({ lot: { $in: ids } });
  const r = await Lot.deleteMany({ _id: { $in: ids } });
  res.json({ ok: true, deleted: r.deletedCount || 0 });
});

router.post('/:id/clear-bounce', async (req, res) => {
  const lot = await Lot.findByIdAndUpdate(
    req.params.id,
    { $set: { bounceCount: 0, lastBounceAt: null, lastBounceError: '' } },
    { new: true }
  );
  if (!lot) return res.status(404).json({ error: 'not_found' });
  res.json(lot);
});

router.post('/:id/send', async (req, res) => {
  const { templateId } = req.body || {};
  if (!templateId) return res.status(400).json({ error: 'templateId_required' });
  const result = await enqueueBroadcast({ lotIds: [req.params.id], templateId });
  res.json(result);
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;

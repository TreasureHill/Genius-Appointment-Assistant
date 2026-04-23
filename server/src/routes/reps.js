const express = require('express');
const Rep = require('../models/Rep');
const Lot = require('../models/Lot');

const router = express.Router();

router.get('/', async (req, res) => {
  const reps = await Rep.find({}).sort({ name: 1 }).lean();
  const counts = await Lot.aggregate([
    { $match: { assignedRep: { $ne: null } } },
    { $group: { _id: '$assignedRep', n: { $sum: 1 } } },
  ]);
  const m = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json(reps.map((r) => ({ ...r, lotCount: m.get(String(r._id)) || 0 })));
});

router.post('/', async (req, res) => {
  const { name, email, phone, calendlyUser, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  const rep = await Rep.create({ name, email, phone, calendlyUser, notes });
  res.status(201).json(rep);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'email', 'phone', 'calendlyUser', 'active', 'notes'];
  const update = {};
  for (const k of allowed) if (k in req.body) update[k] = req.body[k];
  const rep = await Rep.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!rep) return res.status(404).json({ error: 'not_found' });
  res.json(rep);
});

router.delete('/:id', async (req, res) => {
  const count = await Lot.countDocuments({ assignedRep: req.params.id });
  if (count > 0) return res.status(400).json({ error: 'rep_assigned_to_lots', count });
  const rep = await Rep.findByIdAndDelete(req.params.id);
  if (!rep) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;

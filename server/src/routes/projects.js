const express = require('express');
const Project = require('../models/Project');
const Lot = require('../models/Lot');

const router = express.Router();

router.get('/', async (req, res) => {
  const projects = await Project.find({}).sort({ createdAt: -1 }).lean();
  const counts = await Lot.aggregate([
    { $group: { _id: { project: '$project', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const row of counts) {
    const pid = String(row._id.project);
    const entry = map.get(pid) || { total: 0, byStatus: {} };
    entry.total += row.n;
    entry.byStatus[row._id.status] = (entry.byStatus[row._id.status] || 0) + row.n;
    map.set(pid, entry);
  }
  res.json(projects.map((p) => ({ ...p, stats: map.get(String(p._id)) || { total: 0, byStatus: {} } })));
});

router.post('/', async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name_required' });
  const existing = await Project.findOne({ name });
  if (existing) return res.status(409).json({ error: 'project_name_taken' });
  const project = await Project.create({ name, description });
  res.status(201).json(project);
});

router.get('/:id', async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'not_found' });
  res.json(project);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'description', 'active', 'defaultEmailTemplate', 'defaultSmsTemplate'];
  const update = {};
  for (const k of allowed) if (k in req.body) {
    const v = req.body[k];
    if ((k === 'defaultEmailTemplate' || k === 'defaultSmsTemplate') && (v === '' || v === undefined)) {
      update[k] = null;
    } else {
      update[k] = v;
    }
  }
  const project = await Project.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!project) return res.status(404).json({ error: 'not_found' });
  res.json(project);
});

router.delete('/:id', async (req, res) => {
  const lotCount = await Lot.countDocuments({ project: req.params.id });
  if (lotCount > 0) return res.status(400).json({ error: 'project_has_lots', lotCount });
  const p = await Project.findByIdAndDelete(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;

const express = require('express');
const Template = require('../models/Template');

const router = express.Router();

router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  const list = await Template.find(filter).sort({ updatedAt: -1 }).lean();
  res.json(list);
});

router.post('/', async (req, res) => {
  const { name, type, subject, bodyHtml, bodyText, isDefaultReminder } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name_and_type_required' });
  if (!['email', 'sms'].includes(type)) return res.status(400).json({ error: 'invalid_type' });
  if (isDefaultReminder) await Template.updateMany({ type, isDefaultReminder: true }, { isDefaultReminder: false });
  const tpl = await Template.create({
    name,
    type,
    subject: subject || '',
    bodyHtml: bodyHtml || '',
    bodyText: bodyText || '',
    isDefaultReminder: Boolean(isDefaultReminder),
  });
  res.status(201).json(tpl);
});

router.get('/:id', async (req, res) => {
  const tpl = await Template.findById(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  res.json(tpl);
});

router.patch('/:id', async (req, res) => {
  const allowed = ['name', 'subject', 'bodyHtml', 'bodyText', 'isDefaultReminder'];
  const update = {};
  for (const k of allowed) if (k in req.body) update[k] = req.body[k];
  const current = await Template.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  if (update.isDefaultReminder) {
    await Template.updateMany(
      { type: current.type, isDefaultReminder: true, _id: { $ne: current._id } },
      { isDefaultReminder: false }
    );
  }
  Object.assign(current, update);
  await current.save();
  res.json(current);
});

router.delete('/:id', async (req, res) => {
  const tpl = await Template.findByIdAndDelete(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;

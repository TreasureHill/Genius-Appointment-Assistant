const express = require('express');
const Template = require('../models/Template');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const { renderTemplate, renderContext } = require('../services/templateRender');
const { sendEmail, stripHtml } = require('../services/mailer');
const { sendSms } = require('../services/sms');

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

// Render the template against a sample context (or a real lot, if given)
// without actually sending. Useful for previewing exactly what a recipient
// will receive before pulling the trigger.
router.post('/:id/preview', async (req, res) => {
  const tpl = await Template.findById(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  const ctx = await buildSampleContext(req.body || {});
  const rendered = renderTemplate(tpl, ctx);
  res.json({ rendered, type: tpl.type });
});

// Send a one-off test message using this template. Body shape:
//   { to: 'someone@example.com', sampleLotId?: '...' }
// If sampleLotId is given, the template renders against that lot's real
// data; otherwise we substitute a synthetic Jane + John couple so the
// {{buyersDisplay}} helper can be eyeballed.
router.post('/:id/test', async (req, res) => {
  const tpl = await Template.findById(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'not_found' });

  const { to, sampleLotId } = req.body || {};
  if (!to || !String(to).trim()) {
    return res.status(400).json({ error: 'to_required', message: 'Recipient is required' });
  }

  const ctx = await buildSampleContext({ sampleLotId, to });
  const rendered = renderTemplate(tpl, ctx);

  try {
    if (tpl.type === 'email') {
      const info = await sendEmail({
        to,
        subject: `[TEST] ${rendered.subject || tpl.name}`,
        html: rendered.html,
        text: rendered.text || stripHtml(rendered.html || ''),
      });
      return res.json({ ok: true, channel: 'email', providerId: info.messageId, rendered });
    }
    // sms
    const info = await sendSms({ to, body: rendered.text || stripHtml(rendered.html || '') });
    return res.json({ ok: true, channel: 'sms', providerId: info.messageId, rendered });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'send_failed',
      message: err.message || String(err),
      rendered,
    });
  }
});

async function buildSampleContext({ sampleLotId, to }) {
  const setting = await Setting.getSingleton();
  const owner = setting.owner || {};

  if (sampleLotId) {
    const lot = await Lot.findById(sampleLotId).populate('project');
    if (lot) {
      const buyer = (lot.buyers || []).find((b) => b.role === 'buyer') || lot.buyers?.[0] || null;
      return renderContext({ project: lot.project, lot, buyer, owner });
    }
  }

  // Synthetic context — exercises every variable, including coBuyer and
  // the smart {{buyersDisplay}} helper.
  const sampleLot = {
    lotNumber: '101',
    address: '123 Sample Lane',
    status: 'pending',
    buyers: [
      { role: 'buyer', name: 'Jane Owner', email: to || 'jane@example.com', phone: '+15555550101' },
      { role: 'coBuyer', name: 'John Owner', email: 'john@example.com', phone: '+15555550102' },
    ],
  };
  return renderContext({
    project: { name: 'Sample Project' },
    lot: sampleLot,
    buyer: sampleLot.buyers[0],
    owner,
  });
}

module.exports = router;

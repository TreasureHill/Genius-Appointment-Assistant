const express = require('express');
const Setting = require('../models/Setting');
const { verifySmtp, sendEmail } = require('../services/mailer');
const { verifyTwilio, sendSms } = require('../services/sms');
const { verifyCalendly, syncAll } = require('../services/calendly');
const env = require('../config/env');

const router = express.Router();

router.get('/', async (req, res) => {
  const s = await Setting.getSingleton();
  res.json({
    smtp: { configured: env.smtp.configured, from: env.smtp.from, host: env.smtp.host, health: s.smtpHealth },
    twilio: { configured: env.twilio.configured, from: env.twilio.from, health: s.twilioHealth },
    calendly: { configured: env.calendly.configured, health: s.calendlyHealth, lastSync: s.lastCalendlySync },
    senderPaused: s.senderPaused,
    defaults: env.defaults,
  });
});

router.post('/pause', async (req, res) => {
  const { paused } = req.body || {};
  const s = await Setting.getSingleton();
  s.senderPaused = Boolean(paused);
  await s.save();
  res.json({ senderPaused: s.senderPaused });
});

router.post('/test/smtp', async (req, res) => {
  const { to } = req.body || {};
  const verify = await verifySmtp();
  const s = await Setting.getSingleton();
  s.smtpHealth = { ok: verify.ok, checkedAt: new Date(), message: verify.message };
  await s.save();
  if (!verify.ok) return res.status(400).json({ ...verify });
  if (to) {
    try {
      const { messageId } = await sendEmail({
        to,
        subject: 'Genius test email',
        html: '<p>This is a test from the Genius Appointment Assistant.</p>',
        text: 'This is a test from the Genius Appointment Assistant.',
      });
      return res.json({ ok: true, message: verify.message, messageId });
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
  res.json(verify);
});

router.post('/test/twilio', async (req, res) => {
  const { to } = req.body || {};
  const verify = await verifyTwilio();
  const s = await Setting.getSingleton();
  s.twilioHealth = { ok: verify.ok, checkedAt: new Date(), message: verify.message };
  await s.save();
  if (!verify.ok) return res.status(400).json({ ...verify });
  if (to) {
    try {
      const { messageId } = await sendSms({
        to,
        body: 'Test SMS from Genius Appointment Assistant.',
      });
      return res.json({ ok: true, message: verify.message, messageId });
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
  res.json(verify);
});

router.post('/test/calendly', async (req, res) => {
  const verify = await verifyCalendly();
  const s = await Setting.getSingleton();
  s.calendlyHealth = { ok: verify.ok, checkedAt: new Date(), message: verify.message };
  await s.save();
  res.json(verify);
});

router.post('/calendly/sync', async (req, res) => {
  try {
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

module.exports = router;

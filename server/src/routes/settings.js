const express = require('express');
const Setting = require('../models/Setting');
const { verifySmtp, sendEmail } = require('../services/mailer');
const { verifyTwilio, sendSms } = require('../services/sms');
const { verifyCalendly, syncAll } = require('../services/calendly');
const env = require('../config/env');

const router = express.Router();

router.get('/', async (req, res) => {
  const s = await Setting.getSingleton();
  const sched = (s.schedule && s.schedule.toObject ? s.schedule.toObject() : s.schedule) || {};
  res.json({
    owner: s.owner || {},
    schedule: {
      reminderIntervalDays: sched.reminderIntervalDays ?? env.defaults.reminderDays,
      maxReminders: sched.maxReminders ?? env.defaults.maxReminders,
      pacing: sched.pacing || { minSec: env.defaults.pacingMin, maxSec: env.defaults.pacingMax },
      quietHours: sched.quietHours || { enabled: false, start: '21:00', end: '08:00' },
      defaultEmailTemplate: sched.defaultEmailTemplate || null,
      defaultSmsTemplate: sched.defaultSmsTemplate || null,
    },
    smtp: { configured: env.smtp.configured, from: env.smtp.from, host: env.smtp.host, health: s.smtpHealth },
    twilio: { configured: env.twilio.configured, from: env.twilio.from, health: s.twilioHealth },
    calendly: { configured: env.calendly.configured, health: s.calendlyHealth, lastSync: s.lastCalendlySync },
    senderPaused: s.senderPaused,
    emailHighImportance: !!s.emailHighImportance,
    defaults: env.defaults,
  });
});

router.post('/email-importance', async (req, res) => {
  const { enabled } = req.body || {};
  const s = await Setting.getSingleton();
  s.emailHighImportance = Boolean(enabled);
  await s.save();
  res.json({ emailHighImportance: s.emailHighImportance });
});

router.patch('/owner', async (req, res) => {
  const { name, email, phone, calendlyUri, calendlyUrl } = req.body || {};
  const s = await Setting.getSingleton();
  s.owner = s.owner || {};
  if (name != null) s.owner.name = name;
  if (email != null) s.owner.email = email;
  if (phone != null) s.owner.phone = phone;
  if (calendlyUri != null) s.owner.calendlyUri = calendlyUri;
  if (calendlyUrl != null) s.owner.calendlyUrl = calendlyUrl;
  await s.save();
  res.json(s.owner);
});

router.patch('/schedule', async (req, res) => {
  const { reminderIntervalDays, maxReminders, pacing, quietHours, defaultEmailTemplate, defaultSmsTemplate } =
    req.body || {};
  const s = await Setting.getSingleton();
  s.schedule = s.schedule || {};
  if (reminderIntervalDays != null) s.schedule.reminderIntervalDays = Number(reminderIntervalDays);
  if (maxReminders != null) s.schedule.maxReminders = Number(maxReminders);
  if (pacing) {
    s.schedule.pacing = s.schedule.pacing || {};
    if (pacing.minSec != null) s.schedule.pacing.minSec = Number(pacing.minSec);
    if (pacing.maxSec != null) s.schedule.pacing.maxSec = Number(pacing.maxSec);
  }
  if (quietHours) {
    s.schedule.quietHours = s.schedule.quietHours || {};
    if (quietHours.enabled != null) s.schedule.quietHours.enabled = Boolean(quietHours.enabled);
    if (quietHours.start != null) s.schedule.quietHours.start = quietHours.start;
    if (quietHours.end != null) s.schedule.quietHours.end = quietHours.end;
  }
  if (defaultEmailTemplate !== undefined) s.schedule.defaultEmailTemplate = defaultEmailTemplate || null;
  if (defaultSmsTemplate !== undefined) s.schedule.defaultSmsTemplate = defaultSmsTemplate || null;
  await s.save();
  res.json(s.schedule);
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
        highImportance: !!s.emailHighImportance,
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

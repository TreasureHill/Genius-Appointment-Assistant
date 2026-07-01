const express = require('express');
const Setting = require('../models/Setting');
const { verifySmtp, sendEmail } = require('../services/mailer');
const { verifyTwilio, sendSms } = require('../services/sms');
const { verifyCalendly, syncAll, listEventTypes } = require('../services/calendly');
const ariaCall = require('../services/ariaCall');
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
      sendWindows: sched.sendWindows || null,
      defaultEmailTemplate: sched.defaultEmailTemplate || null,
      defaultSmsTemplate: sched.defaultSmsTemplate || null,
    },
    smtp: { configured: env.smtp.configured, from: env.smtp.from, host: env.smtp.host, health: s.smtpHealth },
    twilio: { configured: env.twilio.configured, from: env.twilio.from, health: s.twilioHealth },
    calendly: { configured: env.calendly.configured, health: s.calendlyHealth, lastSync: s.lastCalendlySync },
    aria: {
      // .env-provided (secrets) — reported as booleans only, never echoed back
      apiKeySet: env.elevenlabs.configured,
      agentIdSet: Boolean(env.elevenlabs.agentId),
      agentPhoneSet: Boolean(env.elevenlabs.agentPhoneNumberId),
      dispatchable: env.elevenlabs.dispatchable,
      webhookSecretSet: Boolean(env.elevenlabs.webhookSecret),
      toolSecretSet: Boolean(env.aria.toolSecret),
      // editable in the UI
      calendlyEventTypeUri: s.aria?.calendlyEventTypeUri || env.calendly.eventTypeUri || '',
      timezone: s.aria?.timezone || 'America/New_York',
      firstMessage: s.aria?.firstMessage || '',
      systemPrompt: s.aria?.systemPrompt || '',
    },
    senderPaused: s.senderPaused,
    remindersPaused: !!s.remindersPaused,
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

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

router.patch('/schedule', async (req, res) => {
  const { reminderIntervalDays, maxReminders, pacing, sendWindows, defaultEmailTemplate, defaultSmsTemplate } =
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
  if (sendWindows && typeof sendWindows === 'object') {
    s.schedule.sendWindows = s.schedule.sendWindows || {};
    for (const day of DAY_KEYS) {
      const incoming = sendWindows[day];
      if (!incoming) continue;
      s.schedule.sendWindows[day] = s.schedule.sendWindows[day] || {};
      if (incoming.enabled != null) s.schedule.sendWindows[day].enabled = Boolean(incoming.enabled);
      if (incoming.start != null) s.schedule.sendWindows[day].start = String(incoming.start);
      if (incoming.end != null) s.schedule.sendWindows[day].end = String(incoming.end);
    }
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

router.post('/reminders/pause', async (req, res) => {
  const { paused } = req.body || {};
  const s = await Setting.getSingleton();
  s.remindersPaused = Boolean(paused);
  await s.save();
  res.json({ remindersPaused: s.remindersPaused });
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

// Aria (voice agent) — event type, timezone, and optional prompt overrides.
router.patch('/aria', async (req, res) => {
  const { calendlyEventTypeUri, timezone, firstMessage, systemPrompt } = req.body || {};
  const s = await Setting.getSingleton();
  s.aria = s.aria || {};
  if (calendlyEventTypeUri != null) s.aria.calendlyEventTypeUri = String(calendlyEventTypeUri).trim();
  if (timezone != null) s.aria.timezone = String(timezone).trim() || 'America/New_York';
  if (firstMessage != null) s.aria.firstMessage = String(firstMessage);
  if (systemPrompt != null) s.aria.systemPrompt = String(systemPrompt);
  await s.save();
  res.json(s.aria);
});

// List the owner's Calendly event types so the Aria card can offer a picker.
router.get('/aria/event-types', async (req, res) => {
  try {
    const result = await listEventTypes();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message, eventTypes: [] });
  }
});

// Preview the slots Aria would offer — sanity-checks the Calendly event type
// URI + token without placing a call.
router.post('/aria/availability-preview', async (req, res) => {
  try {
    const result = await ariaCall.getAvailability({ limit: Number(req.body?.limit) || 6 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ available: false, slots: [], message: err.message });
  }
});

module.exports = router;

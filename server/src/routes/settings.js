const express = require('express');
const Setting = require('../models/Setting');
const { verifySmtp, sendEmail } = require('../services/mailer');
const { verifyTwilio, sendSms } = require('../services/sms');
const { verifyCalendly, syncAll, listEventTypes } = require('../services/calendly');
const ariaCall = require('../services/ariaCall');
const elevenlabs = require('../services/elevenlabs');
const Lot = require('../models/Lot');
const env = require('../config/env');
const { isValidTimezone, resolveScheduleTimezone } = require('../services/sendWindow');
const { replanPendingOutbox, scheduleStatus } = require('../services/outboxPlanner');

const router = express.Router();

router.get('/', async (req, res) => {
  const s = await Setting.getSingleton();
  const sched = (s.schedule && s.schedule.toObject ? s.schedule.toObject() : s.schedule) || {};
  const timezone = resolveScheduleTimezone(s);
  res.json({
    owner: s.owner || {},
    schedule: {
      // The zone send windows are written in. `timezoneSource` says whether it
      // was set explicitly or is still inherited (Aria's zone / Eastern).
      timezone,
      timezoneSource: isValidTimezone(sched.timezone) ? 'schedule' : isValidTimezone(s.aria?.timezone) ? 'aria' : 'default',
      window: await scheduleStatus(s),
      emailPerLot: sched.emailPerLot !== false,
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
      calendlyLocationKind: s.aria?.calendlyLocationKind || '',
      calendlyLocationDetail: s.aria?.calendlyLocationDetail || '',
      firstMessage: s.aria?.firstMessage || '',
      systemPrompt: s.aria?.systemPrompt || '',
      // Names the first message / prompt can use as {{placeholder}}.
      placeholders: elevenlabs.placeholderNames(),
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
  const {
    reminderIntervalDays,
    maxReminders,
    pacing,
    sendWindows,
    defaultEmailTemplate,
    defaultSmsTemplate,
    timezone,
    emailPerLot,
  } = req.body || {};
  if (timezone != null && !isValidTimezone(String(timezone).trim())) {
    return res.status(400).json({ error: 'invalid_timezone', message: `"${timezone}" is not a valid IANA timezone (e.g. America/Toronto).` });
  }
  const s = await Setting.getSingleton();
  s.schedule = s.schedule || {};
  if (timezone != null) s.schedule.timezone = String(timezone).trim();
  if (emailPerLot != null) s.schedule.emailPerLot = Boolean(emailPerLot);
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
  // The windows / pacing / timezone just changed: move everything still
  // queued so the Queue page reflects the new schedule immediately.
  const replan = await replanPendingOutbox();
  const out = s.schedule && s.schedule.toObject ? s.schedule.toObject() : s.schedule;
  res.json({ ...out, timezone: resolveScheduleTimezone(s), replan, window: await scheduleStatus(s) });
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
  const { calendlyEventTypeUri, timezone, calendlyLocationKind, calendlyLocationDetail, firstMessage, systemPrompt } = req.body || {};
  const s = await Setting.getSingleton();
  s.aria = s.aria || {};
  if (calendlyEventTypeUri != null) s.aria.calendlyEventTypeUri = String(calendlyEventTypeUri).trim();
  if (timezone != null) s.aria.timezone = String(timezone).trim() || 'America/New_York';
  if (calendlyLocationKind != null) s.aria.calendlyLocationKind = String(calendlyLocationKind).trim();
  if (calendlyLocationDetail != null) s.aria.calendlyLocationDetail = String(calendlyLocationDetail).trim();
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

// Which overrides the ElevenLabs agent accepts (its Security tab). When
// "First message" / "System prompt" are off, the overrides set above are
// refused or ignored and Aria opens with the dashboard default.
router.get('/aria/overrides', async (req, res) => {
  try {
    res.json(await elevenlabs.getOverridePermissions());
  } catch (err) {
    res.status(502).json({ ok: false, reason: 'lookup_failed', message: elevenlabs.describeError(err) });
  }
});

router.post('/aria/overrides/enable', async (req, res) => {
  try {
    res.json(await elevenlabs.enableOverrides({ firstMessage: true, prompt: true }));
  } catch (err) {
    res.status(502).json({ ok: false, message: elevenlabs.describeError(err) });
  }
});

// Render the first message + prompt exactly as a call would send them, for
// a real lot (the given one, or the most recently updated lot with a phone),
// and list placeholders that would be spoken literally. No call is placed.
router.post('/aria/preview', async (req, res) => {
  const { lotId, firstMessage, systemPrompt } = req.body || {};
  const s = await Setting.getSingleton();
  const aria = (s.aria && s.aria.toObject?.()) || s.aria || {};
  // Unsaved edits from the form win over what's stored.
  if (firstMessage != null) aria.firstMessage = String(firstMessage);
  if (systemPrompt != null) aria.systemPrompt = String(systemPrompt);
  const owner = (s.owner && s.owner.toObject?.()) || s.owner || {};

  let lot = null;
  if (lotId) lot = await Lot.findById(lotId).populate('project', 'name marketingName').lean();
  if (!lot) {
    lot = await Lot.findOne({ 'buyers.phone': { $nin: ['', null] } })
      .sort({ updatedAt: -1 })
      .populate('project', 'name marketingName')
      .lean();
  }
  let buyer = null;
  let sample = false;
  if (lot) {
    buyer = (lot.buyers || []).find((b) => b.phone && !b.optedOut) || (lot.buyers || [])[0] || null;
  } else {
    sample = true;
    lot = { _id: '000000000000000000000000', lotNumber: '12', address: '18 Larkspur Way', project: { name: 'Sample Project', marketingName: 'Union Village' } };
    buyer = { role: 'buyer', name: 'Jane Doe', email: 'jane@example.com', phone: '+14165550100' };
  }
  const preview = elevenlabs.previewOverrides({
    lot,
    buyer,
    owner,
    slotsText: 'Tuesday 2:00 PM, Wednesday 10:00 AM (sample — real slots come from Calendly at call time)',
    aria,
  });
  res.json({
    ...preview,
    sample,
    lot: { _id: lot._id, lotNumber: lot.lotNumber, address: lot.address || '', project: lot.project?.marketingName || lot.project?.name || '' },
    buyer: buyer ? { name: buyer.name || '', phone: buyer.phone || '', email: buyer.email || '' } : null,
  });
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

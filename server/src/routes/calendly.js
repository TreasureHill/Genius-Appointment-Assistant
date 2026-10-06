const express = require('express');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const { logStatusChange } = require('../services/lotEventLogger');
const mongoose = require('mongoose');
const EmailThread = require('../models/EmailThread');
const Setting = require('../models/Setting');
const { listEventTypes, bookOnCalendly, createSchedulingLink, formatSlotLabel, syncAll } = require('../services/calendly');
const calendlyConnect = require('../services/calendlyConnect');
const { resolveScheduleTimezone, isValidTimezone } = require('../services/sendWindow');

const router = express.Router();

// ---- Scheduler (inbox → "Schedule on Calendly") ----

router.get('/event-types', async (req, res) => {
  const r = await listEventTypes();
  const s = await Setting.getSingleton();
  res.json({
    ...r,
    eventTypes: (r.eventTypes || []).filter((e) => e.active !== false),
    defaultEventTypeUri: s.integrations?.calendly?.defaultEventTypeUri || s.aria?.calendlyEventTypeUri || '',
    timezone: resolveScheduleTimezone(s),
  });
});

// Open times for an event type in [start, end) — the scheduler asks a week
// at a time.
router.get('/slots', async (req, res) => {
  const { eventType, start, end } = req.query;
  const s = await Setting.getSingleton();
  const tz = isValidTimezone(req.query.tz) ? req.query.tz : resolveScheduleTimezone(s);
  const r = await calendlyConnect.availableTimesInRange({ eventTypeUri: eventType, start, end, timeZone: tz });
  res.status(r.ok ? 200 : 400).json({ ...r, timezone: tz });
});

router.get('/next-available', async (req, res) => {
  const { eventType, from } = req.query;
  const s = await Setting.getSingleton();
  const tz = isValidTimezone(req.query.tz) ? req.query.tz : resolveScheduleTimezone(s);
  const r = await calendlyConnect.nextAvailable({ eventTypeUri: eventType, from, timeZone: tz });
  res.status(r.ok ? 200 : 400).json(r);
});

// Meetings already booked with this person.
router.get('/invitee-events', async (req, res) => {
  res.json(await calendlyConnect.eventsForInvitee(String(req.query.email || '')));
});

// Book a real Calendly event for a name + email (Scheduling API — Calendly
// sends its own invite and confirmation emails).
router.post('/book', async (req, res) => {
  const { eventTypeUri, startTime, name, email, timezone, threadId, answers, phone, locationDetail } = req.body || {};
  if (!eventTypeUri || !startTime || !email) {
    return res.status(400).json({ ok: false, message: 'Event type, time and email are required.' });
  }
  const s = await Setting.getSingleton();
  const tz = isValidTimezone(timezone) ? timezone : resolveScheduleTimezone(s);
  let thread = null;
  if (threadId && mongoose.isValidObjectId(threadId)) {
    thread = await EmailThread.findById(threadId).populate({ path: 'lot', populate: { path: 'project', select: 'name marketingName' } });
  }
  const lot = thread?.lot || null;
  const r = await bookOnCalendly({
    eventTypeUri,
    startTimeIso: startTime,
    name: String(name || '').trim(),
    email: String(email).trim().toLowerCase(),
    timezone: tz,
    phone: phone || (lot?.buyers || []).find((b) => b.email === String(email).toLowerCase())?.phone || '',
    locationDetail,
    projectName: lot?.project ? lot.project.marketingName || lot.project.name : '',
    lotNumber: lot?.lotNumber || '',
    answers,
  });
  if (!r.ok) {
    const plan = r.status === 403 || /upgrade|plan|permission/i.test(r.message || '');
    return res.status(400).json({
      ok: false,
      message: plan ? `${r.message} — booking through the API needs a paid Calendly plan; send the time's booking link instead.` : r.message,
      canSendLink: true,
    });
  }
  const label = formatSlotLabel(startTime, tz);
  if (thread) {
    thread.notes.push({
      kind: 'calendly',
      text: `Booked on Calendly for ${String(name || email).trim()} — ${label}`,
      meta: { eventUri: r.eventUri, startTime, rescheduleUrl: r.rescheduleUrl, cancelUrl: r.cancelUrl, email },
    });
    await thread.save();
  }
  // Pull the new event in so a matching lot flips to scheduled right away.
  syncAll().catch(() => {});
  res.json({ ok: true, eventUri: r.eventUri, label, rescheduleUrl: r.rescheduleUrl, cancelUrl: r.cancelUrl });
});

// A single-use booking link for an event type (when booking via the API
// isn't wanted or available).
router.post('/scheduling-link', async (req, res) => {
  const url = await createSchedulingLink(req.body?.eventTypeUri);
  if (!url) return res.status(400).json({ ok: false, message: 'Calendly could not create a link for this event type.' });
  res.json({ ok: true, url });
});

router.get('/unmatched', async (req, res) => {
  const { status = 'unmatched', q, limit = 200 } = req.query;
  const filter = {};
  if (status !== 'all') filter.status = status;
  if (q) {
    const r = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ inviteeEmail: r }, { inviteeName: r }, { eventName: r }];
  }
  const rows = await CalendlyUnmatch.find(filter)
    .populate({ path: 'mappedLot', populate: { path: 'project', select: 'name' }, select: 'lotNumber' })
    .sort({ lastSeenAt: -1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();
  res.json(rows);
});

// Bulk action on many queue entries at once (drives the "select all" UI).
// action: 'ignore' | 'unresolve' | 'delete'. Bulk mapping is intentionally
// omitted — each invitee maps to a different lot, so it can't be one-shot.
router.post('/unmatched/bulk', async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids_required' });
  }
  const filter = { _id: { $in: ids } };

  if (action === 'ignore') {
    const r = await CalendlyUnmatch.updateMany(filter, { $set: { status: 'ignored' } });
    return res.json({ ok: true, action, modified: r.modifiedCount || 0 });
  }
  if (action === 'unresolve') {
    const r = await CalendlyUnmatch.updateMany(filter, {
      $set: { status: 'unmatched', mappedLot: null, mappedAt: null },
    });
    return res.json({ ok: true, action, modified: r.modifiedCount || 0 });
  }
  if (action === 'delete') {
    const r = await CalendlyUnmatch.deleteMany(filter);
    return res.json({ ok: true, action, deleted: r.deletedCount || 0 });
  }
  return res.status(400).json({ error: 'invalid_action' });
});

router.post('/unmatched/:id/map', async (req, res) => {
  const { lotId, addAsBuyer = true } = req.body || {};
  if (!lotId) return res.status(400).json({ error: 'lotId_required' });

  const entry = await CalendlyUnmatch.findById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });

  const lot = await Lot.findById(lotId).populate('project', 'name');
  if (!lot) return res.status(404).json({ error: 'lot_not_found' });

  const emailLower = entry.inviteeEmail.toLowerCase();
  const alreadyBuyer = (lot.buyers || []).some((b) => (b.email || '').toLowerCase() === emailLower);

  // Optionally add the invitee as a buyer so future Calendly events auto-match
  if (addAsBuyer && !alreadyBuyer) {
    const usedRoles = new Set((lot.buyers || []).map((b) => b.role));
    const nextRole = ['buyer', 'coBuyer', 'thirdBuyer'].find((r) => !usedRoles.has(r));
    if (nextRole) {
      lot.buyers.push({
        role: nextRole,
        name: entry.inviteeName || '',
        email: entry.inviteeEmail,
        phone: '',
        optedOut: false,
      });
    }
  }

  const priorStatus = lot.status;
  if (lot.status !== 'scheduled') lot.status = 'scheduled';
  lot.calendlyEventUri = entry.eventUri || lot.calendlyEventUri;
  await lot.save();

  entry.status = 'mapped';
  entry.mappedLot = lot._id;
  entry.mappedAt = new Date();
  await entry.save();

  if (priorStatus !== 'scheduled') {
    await logStatusChange({
      lot,
      project: lot.project._id,
      fromStatus: priorStatus,
      toStatus: 'scheduled',
      actor: 'calendly_map',
      message: `Manually mapped ${entry.inviteeEmail} to ${entry.eventName || 'Calendly event'}.`,
    });
  }

  await MessageLog.create({
    project: lot.project._id,
    lot: lot._id,
    type: 'calendly',
    direction: 'in',
    to: entry.inviteeEmail,
    subject: entry.eventName || 'Calendly event (manual map)',
    body: `Manually mapped invitee ${entry.inviteeEmail} in event ${entry.eventUri} to lot ${lot.lotNumber}`,
    status: 'received',
    providerId: entry.eventUri,
    sentAt: new Date(),
  });

  res.json({ ok: true, entry, lot });
});

router.post('/unmatched/:id/ignore', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'ignored' } },
    { new: true }
  );
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json(entry);
});

router.post('/unmatched/:id/unresolve', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'unmatched', mappedLot: null, mappedAt: null } },
    { new: true }
  );
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json(entry);
});

router.delete('/unmatched/:id', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndDelete(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;

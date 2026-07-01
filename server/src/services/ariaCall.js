// Aria — outbound voice agent orchestration.
//
// This module is the single place that knows how a phone call flows through
// the app, so the HTTP routes stay thin:
//   dispatchCall()   — place an outbound call to a lot's buyer via ElevenLabs
//   applyPostCall()  — fold the ElevenLabs post-call webhook onto the lot
//   getAvailability()— answer Aria's get_availability tool during the call
//   bookAppointment()— answer Aria's book_appointment tool during the call
//
// Booking note: Calendly's API cannot create a confirmed event server-side, so
// "booking over the phone" means we (a) flip the lot to `scheduled` right away
// with the chosen slot, and (b) text/email the homeowner the Calendly link for
// that exact slot to lock in a real event. When they complete it, the existing
// Calendly webhook/poller reconciles the lot against the real event.

const env = require('../config/env');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Setting = require('../models/Setting');
const elevenlabs = require('./elevenlabs');
const calendly = require('./calendly');
const { logStatusChange } = require('./lotEventLogger');
const { sendSms } = require('./sms');
const { sendEmail } = require('./mailer');
const { enqueueBroadcast, bumpReminderCount } = require('./enqueue');
const { resolveDefaultsForProject } = require('./templateResolver');

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

// Choose which buyer to dial: an explicit role wins, otherwise the first buyer
// that has a phone and hasn't opted out.
function pickBuyer(lot, buyerRole) {
  const buyers = lot.buyers || [];
  if (buyerRole) {
    const b = buyers.find((x) => x.role === buyerRole);
    if (b && b.phone && !b.optedOut) return b;
    return null;
  }
  return buyers.find((b) => b.phone && !b.optedOut) || null;
}

// Find the buyer on a lot that best matches what the agent captured, so a
// booking is attributed to the right role. Tries phone, then email, then name.
function matchBuyer(lot, { phone, email, name }) {
  const buyers = lot.buyers || [];
  const ph = digitsOnly(phone).slice(-10);
  if (ph) {
    const b = buyers.find((x) => digitsOnly(x.phone).slice(-10) === ph);
    if (b) return b;
  }
  const em = String(email || '').toLowerCase().trim();
  if (em) {
    const b = buyers.find((x) => String(x.email || '').toLowerCase().trim() === em);
    if (b) return b;
  }
  const nm = String(name || '').toLowerCase().trim();
  if (nm) {
    const b = buyers.find((x) => String(x.name || '').toLowerCase().trim() === nm);
    if (b) return b;
  }
  return null;
}

// Fire the project's default email + SMS at a single lot (best-effort). Reuses
// the exact resolution + queueing the "Send defaults" button uses, so the
// templates are the ones "set for that project" (project default → system
// default → reminder fallback). enqueueBroadcast already skips scheduled /
// completed / opted-out lots, opted-out buyers, and lots over the reminder cap,
// so it's safe to call unconditionally. Never throws.
async function triggerProjectOutreach(lot) {
  try {
    const projectId = lot.project?._id || lot.project;
    const { emailTpl, smsTpl } = await resolveDefaultsForProject(projectId);
    if (!emailTpl && !smsTpl) return { queued: 0, skipped: 0, note: 'no_default_templates' };

    const queued = [];
    const skipped = [];
    const touched = new Set();
    const used = {};
    for (const tpl of [emailTpl, smsTpl]) {
      if (!tpl) continue;
      const r = await enqueueBroadcast({ lotIds: [lot._id], templateId: tpl._id });
      queued.push(...r.queued);
      skipped.push(...r.skipped);
      r.touchedLotIds.forEach((id) => touched.add(id));
      used[tpl.type] = tpl.name;
    }
    // One reminder bump per call (email + SMS together = one touch), matching
    // the Send-defaults semantics.
    if (touched.size) await bumpReminderCount(Array.from(touched));
    return { queued: queued.length, skipped: skipped.length, used };
  } catch (e) {
    return { queued: 0, skipped: 0, error: e.message };
  }
}

// Place an outbound call to a lot's buyer. Returns { ok, conversationId } or
// throws an Error with a `.code` the route maps to an HTTP status.
async function dispatchCall({ lotId, buyerRole }) {
  const lot = await Lot.findById(lotId).populate('project', 'name marketingName');
  if (!lot) {
    const err = new Error('lot_not_found');
    err.code = 'lot_not_found';
    throw err;
  }
  if (lot.status === 'opted_out') {
    const err = new Error('lot_opted_out');
    err.code = 'lot_opted_out';
    throw err;
  }
  const buyer = pickBuyer(lot, buyerRole);
  if (!buyer) {
    const err = new Error('no_callable_buyer');
    err.code = 'no_callable_buyer';
    throw err;
  }
  if (!elevenlabs.isDispatchable()) {
    const err = new Error('not_dispatchable');
    err.code = 'not_dispatchable';
    throw err;
  }

  const setting = await Setting.getSingleton();
  const owner = (setting.owner && setting.owner.toObject?.()) || setting.owner || {};
  const aria = (setting.aria && setting.aria.toObject?.()) || setting.aria || {};

  // Best-effort: hand Aria the next few open slots up front so it can offer
  // times immediately, even before it calls the availability tool.
  let slotsText = '';
  try {
    const avail = await calendly.listAvailableTimes({ limit: 5 });
    if (avail.ok && avail.slots.length) {
      slotsText = avail.slots.map((s) => s.label).join('; ');
    }
  } catch {
    /* availability is a nicety, never block the call on it */
  }

  const resp = await elevenlabs.startOutboundCall({ lot, buyer, owner, slotsText, aria });
  const conversationId = resp?.conversation_id || resp?.conversationId || '';

  const now = new Date();
  lot.call = {
    status: 'calling',
    conversationId,
    toNumber: elevenlabs.normalizePhone(buyer.phone),
    toBuyerRole: buyer.role,
    startedAt: now,
    endedAt: null,
    durationSec: 0,
    summary: '',
    transcript: '',
    recordingUrl: '',
    outcome: '',
    booked: false,
    attempts: (lot.call?.attempts || 0) + 1,
  };
  lot.markModified('call');
  await lot.save();

  await MessageLog.create({
    project: lot.project?._id || lot.project,
    lot: lot._id,
    type: 'call',
    direction: 'out',
    to: buyer.phone,
    subject: `Aria called ${buyer.name || buyer.phone}`,
    body: slotsText ? `Offering slots: ${slotsText}` : 'Outbound call placed.',
    status: 'sending',
    providerId: conversationId,
    sentAt: now,
  });

  // Auto-send the project's default email + SMS alongside the call.
  const outreach = await triggerProjectOutreach(lot);

  return { ok: true, conversationId, buyerRole: buyer.role, to: buyer.phone, outreach };
}

// Fold an ElevenLabs post-call webhook (already normalised) onto the lot.
// Idempotent per conversation_id.
async function applyPostCall(normalised) {
  if (!normalised.lotId) return { ignored: 'no_lot_id' };
  const lot = await Lot.findById(normalised.lotId).populate('project', 'name');
  if (!lot) return { ignored: 'lot_not_found' };

  const cid = normalised.conversationId;
  const terminal = ['completed', 'voicemail', 'no_answer', 'failed'];
  if (cid && lot.call?.conversationId === cid && terminal.includes(lot.call?.status)) {
    return { deduped: true };
  }

  const now = new Date();
  lot.call = lot.call || {};
  lot.call.status = normalised.status;
  lot.call.endedAt = now;
  lot.call.durationSec = normalised.durationSec || 0;
  lot.call.summary = normalised.summary || '';
  lot.call.transcript = normalised.transcript || '';
  lot.call.outcome = normalised.outcome || normalised.status;
  if (cid) lot.call.conversationId = cid;
  if (normalised.recordingUrl) lot.call.recordingUrl = normalised.recordingUrl;
  lot.markModified('call');
  await lot.save();

  const dc = normalised.dataCollection || {};
  const dcBits = Object.entries(dc)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  await MessageLog.create({
    project: lot.project?._id || lot.project,
    lot: lot._id,
    type: 'call',
    direction: 'in',
    to: lot.call.toNumber || '',
    subject: `Aria call ${normalised.status}${normalised.durationSec ? ` · ${normalised.durationSec}s` : ''}`,
    body: [normalised.summary, dcBits, normalised.transcript]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 4000),
    status: 'received',
    providerId: cid || '',
    sentAt: now,
  });

  return { ok: true, status: normalised.status };
}

// Answer the get_availability tool. `lotId` is optional (used only for logs).
async function getAvailability({ limit = 6 } = {}) {
  const avail = await calendly.listAvailableTimes({ limit });
  if (!avail.ok) {
    return { available: false, message: avail.message, slots: [] };
  }
  if (!avail.slots.length) {
    return {
      available: false,
      message: 'I don’t see any open times on the calendar right now.',
      slots: [],
    };
  }
  return {
    available: true,
    slots: avail.slots.map((s) => ({ start_time: s.startTime, label: s.label })),
    message: `The next openings are: ${avail.slots.map((s) => s.label).join('; ')}.`,
  };
}

// Best-effort delivery of the confirmation link to the homeowner. Never throws.
// `contact` is the resolved { name, email, phone } — prefers what the agent
// captured on the call, falling back to the lot buyer.
async function sendConfirmation({ lot, contact, label, schedulingUrl }) {
  const results = { sms: null, email: null };
  if (!schedulingUrl) return results;
  const projectName = lot.project?.name || 'your appointment';
  const firstName = contact.name ? ` ${contact.name.split(/\s+/)[0]}` : '';
  const smsBody =
    `Hi${firstName}! This confirms ${label} for ${projectName}. ` +
    `Tap to lock it in: ${schedulingUrl}`;
  if (env.twilio.configured && contact.phone) {
    try {
      const r = await sendSms({ to: contact.phone, body: smsBody });
      results.sms = r.messageId || 'sent';
      await logChannel(lot, 'sms', contact.phone, smsBody, r.messageId);
    } catch (e) {
      results.sms = `error: ${e.message}`;
    }
  }
  if (env.smtp.configured && contact.email) {
    try {
      const subject = `Confirm your ${projectName} appointment (${label})`;
      const html =
        `<p>Hi ${contact.name || 'there'},</p>` +
        `<p>This confirms your appointment for <strong>${label}</strong>.</p>` +
        `<p><a href="${schedulingUrl}">Click here to confirm and add it to your calendar</a>.</p>`;
      const r = await sendEmail({ to: contact.email, subject, html, text: `${subject}\n\n${schedulingUrl}` });
      results.email = r.messageId || 'sent';
      await logChannel(lot, 'email', contact.email, subject, r.messageId);
    } catch (e) {
      results.email = `error: ${e.message}`;
    }
  }
  return results;
}

async function logChannel(lot, type, to, body, providerId) {
  try {
    await MessageLog.create({
      project: lot.project?._id || lot.project,
      lot: lot._id,
      type,
      direction: 'out',
      to,
      subject: type === 'email' ? body : '',
      body: type === 'sms' ? body : '',
      status: 'sent',
      providerId: providerId || '',
      sentAt: new Date(),
    });
  } catch {
    /* logging is never fatal */
  }
}

// Answer the book_appointment tool: record the chosen slot on the lot, flip it
// to `scheduled`, and fire off the confirmation link. Returns a shape whose
// `message` Aria can read back to the homeowner verbatim.
async function bookAppointment({ lotId, startTime, buyerName, buyerEmail, buyerPhone }) {
  if (!lotId) return { booked: false, message: 'I couldn’t find your record to book against.' };
  const lot = await Lot.findById(lotId).populate('project', 'name');
  if (!lot) return { booked: false, message: 'I couldn’t find your record to book against.' };
  if (lot.status === 'opted_out') {
    return { booked: false, message: 'This contact has opted out, so I can’t book a time.' };
  }
  if (!startTime) {
    return { booked: false, message: 'Which time would you like? I need a specific slot to book.' };
  }

  const tz = await calendly.resolveTimezone();
  const eventTypeUri = await calendly.resolveEventTypeUri();

  // Try to match the requested time to a real open slot so we can use its
  // exact scheduling URL. Tolerate small differences by comparing to the
  // minute.
  let schedulingUrl = '';
  let matchedIso = startTime;
  let label = calendly.formatSlotLabel(startTime, tz);
  try {
    const avail = await calendly.listAvailableTimes({ limit: 50, days: 60 });
    const wanted = new Date(startTime).getTime();
    const match = (avail.slots || []).find(
      (s) => Math.abs(new Date(s.startTime).getTime() - wanted) < 60 * 1000
    );
    if (match) {
      schedulingUrl = match.schedulingUrl;
      matchedIso = match.startTime;
      label = match.label;
    }
  } catch {
    /* fall through to a freshly minted link */
  }
  if (!schedulingUrl) schedulingUrl = await calendly.createSchedulingLink(eventTypeUri);

  // The agent is told to pass an ISO start_time (from the availability tool),
  // but guard against free-text ("Tuesday at 2pm") so a bad value can't throw a
  // Mongoose cast error mid-booking.
  const startDate = new Date(matchedIso);
  if (!Number.isFinite(startDate.getTime())) {
    return {
      booked: false,
      message: 'I didn’t catch a valid time — could you tell me the exact date and time again?',
    };
  }

  const buyer =
    matchBuyer(lot, { phone: buyerPhone, email: buyerEmail, name: buyerName }) ||
    (lot.buyers || []).find((b) => b.role === lot.call?.toBuyerRole) ||
    (lot.buyers || [])[0] ||
    null;

  const priorStatus = lot.status;
  const now = new Date();
  lot.status = 'scheduled';
  lot.calendlyWarning = '';
  lot.calendlyEvent = {
    name: `${lot.project?.name || 'Appointment'} — booked by Aria`,
    startTime: startDate,
    endTime: null,
    inviteeName: buyerName || buyer?.name || '',
    inviteeEmail: (buyerEmail || buyer?.email || '').toLowerCase(),
    inviteeStatus: 'active',
    matchedBuyerRole: buyer?.role || lot.call?.toBuyerRole || '',
    location: 'Phone booking',
    rescheduleUrl: '',
    cancelUrl: '',
    lastSyncedAt: now,
    bookedByAria: true,
    schedulingUrl,
  };
  if (lot.call) lot.call.booked = true;
  lot.markModified('calendlyEvent');
  lot.markModified('call');
  await lot.save();

  // Stop any pending outreach now that it's scheduled (mirrors the status route).
  await Outbox.updateMany(
    { lot: lot._id, status: 'pending' },
    { $set: { status: 'cancelled', lastError: 'lot scheduled by Aria' } }
  );

  await MessageLog.create({
    project: lot.project?._id || lot.project,
    lot: lot._id,
    type: 'calendly',
    direction: 'in',
    to: buyerEmail || buyer?.email || buyer?.phone || '',
    subject: 'Aria booked appointment',
    body: `Aria booked ${label} over the phone. Confirmation link: ${schedulingUrl || '(none available)'}`,
    status: 'received',
    providerId: '',
    sentAt: now,
  });
  await logStatusChange({
    lot,
    project: lot.project?._id || lot.project,
    fromStatus: priorStatus,
    toStatus: 'scheduled',
    actor: 'aria_call',
    message: `Aria booked ${label} over the phone.`,
  });

  // Prefer the contact details the agent captured on the call; fall back to the
  // lot buyer (and to the number we actually dialed for the phone).
  const contact = {
    name: buyerName || buyer?.name || '',
    email: (buyerEmail || buyer?.email || '').trim(),
    phone: buyerPhone || buyer?.phone || lot.call?.toNumber || '',
  };
  const delivery = await sendConfirmation({ lot, contact, label, schedulingUrl });

  const sentBits = [];
  if (delivery.sms && !String(delivery.sms).startsWith('error')) sentBits.push('a text');
  if (delivery.email && !String(delivery.email).startsWith('error')) sentBits.push('an email');
  const sentPhrase = sentBits.length
    ? ` I’ve sent ${sentBits.join(' and ')} with the confirmation link.`
    : '';

  return {
    booked: true,
    start_time: matchedIso,
    label,
    scheduling_url: schedulingUrl,
    message: `Perfect — you’re booked for ${label}.${sentPhrase}`,
  };
}

module.exports = {
  dispatchCall,
  applyPostCall,
  getAvailability,
  bookAppointment,
  // exported for tests
  pickBuyer,
  matchBuyer,
};

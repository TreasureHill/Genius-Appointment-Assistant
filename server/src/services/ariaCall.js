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
const { bumpReminderCount } = require('./enqueue');
const { resolveDefaultsForProject } = require('./templateResolver');
const { renderContext, renderTemplate } = require('./templateRender');
const { sendEmail } = require('./mailer');
const { sendSms } = require('./sms');

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

// Fire the project's default email + SMS at a single lot the moment the call is
// placed. Unlike the "Send defaults" button (which queues into the paced outbox
// and only sends inside the configured send window), this sends IMMEDIATELY and
// bypasses the send window — the homeowner is being called right now, so the
// accompanying email/SMS should go out now, not defer to 9am. Templates resolve
// the same way ("set for that project": project default → system default →
// reminder fallback). Best-effort; never throws. Returns { sent, used, skipped }.
async function triggerProjectOutreach(lot) {
  try {
    const projectId = lot.project?._id || lot.project;
    const { emailTpl, smsTpl } = await resolveDefaultsForProject(projectId);
    if (!emailTpl && !smsTpl) return { sent: 0, used: {}, skipped: ['no_default_templates'] };

    const setting = await Setting.getSingleton();
    const owner = (setting.owner && setting.owner.toObject?.()) || setting.owner || {};
    const used = {};
    const skipped = [];
    let sent = 0;
    const doneAddrs = new Set();

    for (const buyer of lot.buyers || []) {
      if (buyer.optedOut) continue;
      // Email
      if (emailTpl && buyer.email) {
        const key = `e:${String(buyer.email).toLowerCase()}`;
        if (!doneAddrs.has(key)) {
          doneAddrs.add(key);
          if (!env.smtp.configured) {
            if (!skipped.includes('smtp_not_configured')) skipped.push('smtp_not_configured');
          } else {
            try {
              const ctx = renderContext({ project: lot.project, lot, buyer, owner });
              const r = renderTemplate(emailTpl, ctx);
              const info = await sendEmail({
                to: buyer.email,
                subject: r.subject,
                html: r.html,
                text: r.text,
                highImportance: !!setting.emailHighImportance,
              });
              await logOutreach(lot, 'email', buyer, r.subject, r.html, info.messageId);
              used.email = emailTpl.name;
              sent += 1;
            } catch (e) {
              await logOutreach(lot, 'email', buyer, emailTpl.name, '', '', e.message);
              if (!skipped.includes('email_failed')) skipped.push('email_failed');
            }
          }
        }
      }
      // SMS
      if (smsTpl && buyer.phone) {
        const key = `s:${String(buyer.phone).replace(/\D/g, '')}`;
        if (!doneAddrs.has(key)) {
          doneAddrs.add(key);
          if (!env.twilio.configured) {
            if (!skipped.includes('twilio_not_configured')) skipped.push('twilio_not_configured');
          } else {
            try {
              const ctx = renderContext({ project: lot.project, lot, buyer, owner });
              const r = renderTemplate(smsTpl, ctx);
              const body = r.text || r.html;
              const info = await sendSms({ to: buyer.phone, body });
              await logOutreach(lot, 'sms', buyer, '', body, info.messageId);
              used.sms = smsTpl.name;
              sent += 1;
            } catch (e) {
              await logOutreach(lot, 'sms', buyer, '', smsTpl.name, '', e.message);
              if (!skipped.includes('sms_failed')) skipped.push('sms_failed');
            }
          }
        }
      }
    }

    if (sent > 0) await bumpReminderCount([lot._id]);
    return { sent, used, skipped };
  } catch (e) {
    return { sent: 0, used: {}, skipped: [], error: e.message };
  }
}

async function logOutreach(lot, type, buyer, subject, body, providerId, error) {
  try {
    await MessageLog.create({
      project: lot.project?._id || lot.project,
      lot: lot._id,
      type,
      direction: 'out',
      to: type === 'email' ? buyer.email : buyer.phone,
      subject: subject || '',
      body: body || '',
      status: error ? 'failed' : 'sent',
      error: error || '',
      providerId: providerId || '',
      sentAt: new Date(),
    });
  } catch {
    /* logging never fatal */
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

// Answer the book_appointment tool: actually book the chosen slot on Calendly
// (Create Event Invitee), then flip the lot to `scheduled`. Calendly sends its
// own calendar invite/notifications; the project's template email + SMS already
// went out when the call was placed, so we don't send anything extra here.
// Returns a shape whose `message` Aria reads back to the homeowner.
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

  // Guard against free-text ("Tuesday at 2pm") — the agent should pass the exact
  // ISO start_time returned by get_availability.
  const startDate = new Date(startTime);
  if (!Number.isFinite(startDate.getTime())) {
    return {
      booked: false,
      message: 'I didn’t catch a valid time — could you tell me the exact date and time again?',
    };
  }

  const setting = await Setting.getSingleton();
  const aria = (setting.aria && setting.aria.toObject?.()) || setting.aria || {};
  const tz = aria.timezone || 'America/New_York';
  const eventTypeUri = aria.calendlyEventTypeUri || env.calendly.eventTypeUri || '';
  const label = calendly.formatSlotLabel(startDate.toISOString(), tz);

  const buyer =
    matchBuyer(lot, { phone: buyerPhone, email: buyerEmail, name: buyerName }) ||
    (lot.buyers || []).find((b) => b.role === lot.call?.toBuyerRole) ||
    (lot.buyers || [])[0] ||
    null;
  const name = buyerName || buyer?.name || '';
  const email = (buyerEmail || buyer?.email || '').trim().toLowerCase();

  // Calendly requires an invitee email to create the booking.
  if (!email) {
    return {
      booked: false,
      needsEmail: true,
      message: 'I just need an email address to send the calendar invite — what’s the best email for you?',
    };
  }

  // Actually book it on Calendly.
  const result = await calendly.bookOnCalendly({
    eventTypeUri,
    startTimeIso: startDate.toISOString(),
    name,
    email,
    timezone: tz,
    phone: buyerPhone || buyer?.phone || lot.call?.toNumber || '',
    locationKind: aria.calendlyLocationKind || '',
  });

  if (!result.ok) {
    await MessageLog.create({
      project: lot.project?._id || lot.project,
      lot: lot._id,
      type: 'calendly',
      direction: 'in',
      to: email,
      subject: 'Aria booking failed',
      body: `Aria tried to book ${label} on Calendly but it failed: ${result.message || 'unknown error'}`,
      status: 'failed',
      error: result.message || '',
      sentAt: new Date(),
    }).catch(() => {});
    // A taken slot is the common recoverable case — nudge the agent to re-offer.
    const taken = /already|taken|no longer|unavailable|conflict/i.test(result.message || '');
    return {
      booked: false,
      message: taken
        ? 'It looks like that time was just taken — let me check what else is open.'
        : 'I wasn’t able to lock that in just now. Let me try another time or have someone follow up.',
      error: result.message,
    };
  }

  const priorStatus = lot.status;
  const now = new Date();
  lot.status = 'scheduled';
  lot.calendlyWarning = '';
  lot.calendlyEventUri = result.eventUri || lot.calendlyEventUri;
  lot.calendlyEvent = {
    name: `${lot.project?.name || 'Appointment'} — booked by Aria`,
    startTime: startDate,
    endTime: null,
    inviteeName: name,
    inviteeEmail: email,
    inviteeStatus: 'active',
    matchedBuyerRole: buyer?.role || lot.call?.toBuyerRole || '',
    location: '',
    rescheduleUrl: result.rescheduleUrl || '',
    cancelUrl: result.cancelUrl || '',
    lastSyncedAt: now,
    bookedByAria: true,
    schedulingUrl: '',
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
    to: email,
    subject: 'Aria booked appointment on Calendly',
    body: `Aria booked ${label} on Calendly for ${name || email}.`,
    status: 'received',
    providerId: result.eventUri || '',
    sentAt: now,
  });
  await logStatusChange({
    lot,
    project: lot.project?._id || lot.project,
    fromStatus: priorStatus,
    toStatus: 'scheduled',
    actor: 'aria_call',
    message: `Aria booked ${label} on Calendly.`,
  });

  return {
    booked: true,
    start_time: startDate.toISOString(),
    label,
    message: `Perfect — you’re all booked for ${label}. You’ll get a calendar invite by email shortly.`,
  };
}

// Poll fallback: fold any call still marked 'calling' onto its lot by asking
// ElevenLabs for the finished conversation. Covers BOTH manual and queued calls
// for when the post-call webhook isn't configured or was dropped. Bounded per
// tick. Idempotent via applyPostCall.
async function reconcileCallingLots({ limit = 15 } = {}) {
  const lots = await Lot.find({ 'call.status': 'calling', 'call.conversationId': { $ne: '' } })
    .select('call project')
    .limit(limit)
    .lean();
  let applied = 0;
  for (const lot of lots) {
    const cid = lot.call?.conversationId;
    if (!cid) continue;
    const conv = await elevenlabs.fetchConversation(cid);
    if (!conv) continue;
    const st = String(conv.status || '').toLowerCase();
    if (!['done', 'completed', 'failed', 'processed'].includes(st)) continue;
    const normalised = elevenlabs.normalisePostCallPayload(conv);
    normalised.lotId = String(lot._id);
    if (!normalised.conversationId) normalised.conversationId = cid;
    await applyPostCall(normalised);
    applied += 1;
  }
  return { applied };
}

module.exports = {
  dispatchCall,
  applyPostCall,
  getAvailability,
  bookAppointment,
  reconcileCallingLots,
  // exported for tests
  pickBuyer,
  matchBuyer,
};

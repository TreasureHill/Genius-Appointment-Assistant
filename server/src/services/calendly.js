const axios = require('axios');
const env = require('../config/env');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const MessageLog = require('../models/MessageLog');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');
const { logStatusChange } = require('./lotEventLogger');

const API_BASE = 'https://api.calendly.com';

function client() {
  if (!env.calendly.token) return null;
  return axios.create({
    baseURL: API_BASE,
    headers: {
      Authorization: `Bearer ${env.calendly.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });
}

async function verifyCalendly() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly token not configured' };
  try {
    const { data } = await c.get('/users/me');
    return {
      ok: true,
      message: `Connected as ${data.resource?.name || 'unknown'}`,
      user: data.resource,
    };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || err.message };
  }
}

// Pull scheduled events for the given user URI, following pagination. Options:
//   minStart / maxStart — ISO bounds (Calendly's default window hides events)
//   status — 'active' | 'canceled' (omit to get every status)
// Shared by the live poll and the reconcile script.
async function listEvents(userUri, { minStart, maxStart, status } = {}) {
  const c = client();
  if (!c) return [];
  const params = new URLSearchParams();
  params.set('user', userUri);
  params.set('count', '100');
  if (minStart) params.set('min_start_time', minStart);
  if (maxStart) params.set('max_start_time', maxStart);
  if (status) params.set('status', status);
  const out = [];
  let url = `/scheduled_events?${params.toString()}`;
  while (url) {
    const { data } = await c.get(url);
    out.push(...(data.collection || []));
    url = data.pagination?.next_page ? data.pagination.next_page.replace(API_BASE, '') : null;
  }
  return out;
}

// The live poll only cares about active events from 30 days ago through a year
// ahead (recent + upcoming).
async function listActiveEvents(userUri) {
  const minStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const maxStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return listEvents(userUri, { minStart, maxStart, status: 'active' });
}

async function listInvitees(eventUri) {
  const c = client();
  if (!c) return [];
  const eventId = eventUri.split('/').pop();
  const out = [];
  let url = `/scheduled_events/${eventId}/invitees?count=100`;
  // Follow pagination — a group event can have >100 invitees and we used to
  // silently keep only the first page.
  while (url) {
    const { data } = await c.get(url);
    out.push(...(data.collection || []));
    url = data.pagination?.next_page ? data.pagination.next_page.replace(API_BASE, '') : null;
  }
  return out;
}

// ---- Pure helpers (no I/O — unit-tested in scripts/__tests__) ----

function normalizeEmail(s) {
  return String(s || '').toLowerCase().trim();
}

// Has this Calendly event already finished? Calendly keeps status='active' for
// past events, so time — not status — is what tells us an appointment happened.
// Falls back to start_time when end_time is absent.
function eventHasEnded(event, now = Date.now()) {
  if (!event) return false;
  const endRaw = event.end_time || event.endTime || event.start_time || event.startTime || null;
  if (!endRaw) return false;
  const end = endRaw instanceof Date ? endRaw : new Date(endRaw);
  return Number.isFinite(end.getTime()) && end.getTime() <= now;
}

// What status should a matched lot have, given the event and the lot's current
// status? Used by the reconcile script. Returns null when the lot should be
// left untouched (terminal/opted-out states).
function reconcileTargetStatus(currentStatus, event, now = Date.now()) {
  if (currentStatus === 'opted_out') return null; // never override an opt-out
  return eventHasEnded(event, now) ? 'completed' : 'scheduled';
}

// Build the lot.calendlyEvent subdocument from a matched occurrence. Shared by
// syncAll and the reconcile script so the shape never drifts between them.
function buildLotCalendlyEvent(occurrence, email, role) {
  return {
    name: occurrence.eventName || '',
    startTime: occurrence.startTime ? new Date(occurrence.startTime) : null,
    endTime: occurrence.endTime ? new Date(occurrence.endTime) : null,
    inviteeName: occurrence.inviteeName || '',
    inviteeEmail: email,
    inviteeStatus: occurrence.inviteeStatus || '',
    matchedBuyerRole: role || '',
    location: occurrence.location || '',
    rescheduleUrl: occurrence.rescheduleUrl || '',
    cancelUrl: occurrence.cancelUrl || '',
    lastSyncedAt: new Date(),
  };
}

// Find every buyer on a lot whose email appears in the occurrence map. Pure.
function findLotHits(lot, emailOccurrences) {
  const hits = [];
  for (const b of lot.buyers || []) {
    const email = normalizeEmail(b.email);
    if (!email) continue;
    const occ = emailOccurrences.get(email);
    if (occ && occ.length) {
      hits.push({ email, role: b.role, name: b.name, occurrences: occ });
    }
  }
  return hits;
}

// Walk every event, fetch its invitees, and index them by lowercased email →
// [occurrence]. Shared by syncAll and the reconcile script.
async function collectOccurrences(events) {
  const emailOccurrences = new Map();
  for (const ev of events) {
    let invitees = [];
    try {
      invitees = await listInvitees(ev.uri);
    } catch (err) {
      console.warn('[calendly] invitees fetch failed', ev.uri, err.message);
    }
    for (const inv of invitees) {
      const email = normalizeEmail(inv.email);
      if (!email) continue;
      const entry = {
        eventUri: ev.uri,
        eventName: ev.name,
        startTime: ev.start_time,
        endTime: ev.end_time,
        location: ev.location?.location || ev.location?.join_url || '',
        inviteeName: inv.name || '',
        inviteeStatus: inv.status,
        rescheduleUrl: inv.reschedule_url || '',
        cancelUrl: inv.cancel_url || '',
      };
      const arr = emailOccurrences.get(email) || [];
      arr.push(entry);
      emailOccurrences.set(email, arr);
    }
  }
  return emailOccurrences;
}

// Sync the single owner's Calendly events: pull scheduled_events, match
// invitees to lot buyers by email, flip matches to 'scheduled'. Anything
// unmatched goes into CalendlyUnmatch for manual mapping.
async function syncAll() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly not configured (missing CALENDLY_TOKEN)' };

  const setting = await Setting.getSingleton();
  const userUri = setting.owner?.calendlyUri || env.calendly.userUri;
  if (!userUri) {
    return {
      ok: false,
      message:
        'Owner Calendly URI not set. Open Settings → Owner and paste your Calendly user URI.',
    };
  }

  let events = [];
  try {
    events = await listActiveEvents(userUri);
  } catch (err) {
    setting.calendlyHealth = {
      ok: false,
      checkedAt: new Date(),
      message: err.response?.data?.message || err.message,
    };
    await setting.save();
    return { ok: false, message: err.response?.data?.message || err.message };
  }

  // Collect invitees: email → [{event info}]
  const emailOccurrences = await collectOccurrences(events);

  const emails = Array.from(emailOccurrences.keys());
  const matchedEmails = new Set();
  const matched = [];
  const reMatched = [];

  if (emails.length) {
    // Match against ALL buyer roles (buyer, coBuyer, thirdBuyer). The
    // BuyerSchema lowercases email on save, but findLotHits re-normalizes in
    // case any legacy rows have mixed-case values.
    const lots = await Lot.find({ 'buyers.email': { $in: emails } });
    for (const lot of lots) {
      const hits = findLotHits(lot, emailOccurrences);
      if (!hits.length) continue;

      // This invitee is accounted for, so it must never be flagged as
      // "unmatched" below — even when the guards that follow deliberately leave
      // the lot's status untouched.
      for (const h of hits) matchedEmails.add(h.email.toLowerCase());

      // Never override a human/terminal decision. A Calendly event that has
      // already happened STILL reports status=active, so without this guard the
      // 30-min poll keeps reverting completed/opted_out lots back to scheduled
      // (fighting the completion tracker) on every single run.
      if (lot.status === 'completed' || lot.status === 'opted_out') continue;

      const multi = hits.some((h) => h.occurrences.length > 1);
      const firstHit = hits[0].occurrences[0];
      const alreadyMatchedSameEvent =
        lot.calendlyEventUri && lot.calendlyEventUri === firstHit.eventUri;

      // Already scheduled against this exact event → nothing changed. Skip the
      // save + activity log entirely so the poll doesn't churn updatedAt or
      // spam the feed every cycle.
      if (alreadyMatchedSameEvent && lot.status === 'scheduled') {
        reMatched.push({ lotId: String(lot._id), email: hits[0].email });
        continue;
      }

      const priorStatus = lot.status;
      lot.status = 'scheduled';
      lot.calendlyEventUri = firstHit.eventUri || lot.calendlyEventUri;
      lot.calendlyWarning = multi
        ? `Invitee appears in multiple active Calendly events (${hits[0].occurrences.length}). Check for duplicates.`
        : '';
      lot.calendlyEvent = buildLotCalendlyEvent(firstHit, hits[0].email, hits[0].role);
      await lot.save();

      await MessageLog.create({
        project: lot.project,
        lot: lot._id,
        type: 'calendly',
        direction: 'in',
        to: hits[0].email,
        subject: firstHit.eventName || 'Calendly event',
        body: `Matched invitee ${hits[0].email} (${hits[0].role}) in event ${firstHit.eventUri}`,
        status: 'received',
        providerId: firstHit.eventUri,
        sentAt: new Date(),
      });
      if (priorStatus !== 'scheduled') {
        await logStatusChange({
          lot,
          project: lot.project,
          fromStatus: priorStatus,
          toStatus: 'scheduled',
          actor: 'calendly_sync',
          message: `Calendly auto-matched ${hits[0].email} to ${firstHit.eventName || 'event'}.`,
        });
      }
      matched.push({ lotId: String(lot._id), email: hits[0].email, multi });
    }
  }

  // Persist unmatched invitees for manual mapping in the UI
  let unmatchedCount = 0;
  for (const [email, occurrences] of emailOccurrences) {
    if (matchedEmails.has(email)) continue;
    for (const occ of occurrences) {
      await CalendlyUnmatch.updateOne(
        { eventUri: occ.eventUri, inviteeEmail: email },
        {
          $set: { lastSeenAt: new Date() },
          $setOnInsert: {
            eventUri: occ.eventUri,
            eventName: occ.eventName || '',
            eventStartTime: occ.startTime ? new Date(occ.startTime) : null,
            inviteeEmail: email,
            inviteeName: occ.inviteeName || '',
            inviteeStatus: occ.inviteeStatus || '',
            status: 'unmatched',
          },
        },
        { upsert: true }
      );
      unmatchedCount += 1;
    }
  }

  setting.lastCalendlySync = new Date();
  setting.calendlyHealth = {
    ok: true,
    checkedAt: new Date(),
    message: `Sync ran: ${events.length} events, ${emails.length} invitees`,
  };
  await setting.save();

  return {
    ok: true,
    events: events.length,
    emailsSeen: emails.length,
    matched,
    reMatched: reMatched.length,
    unmatched: unmatchedCount,
  };
}

// Handle a single webhook payload from Calendly. The route forwards both
// invitee.created and invitee.canceled events here.
async function handleWebhook(payload) {
  const webhookType = payload?.event || payload?.type || '';
  const invitee = payload?.payload || {};
  const email = normalizeEmail(invitee.email);
  const eventUri = invitee.event || payload?.payload?.scheduled_event?.uri || '';
  const ev = payload?.payload?.scheduled_event || {};
  if (!email) return { matched: 0 };

  // A cancellation must NOT flip the lot to scheduled — revert it instead.
  if (webhookType.includes('cancel')) {
    return handleCancellation({ email, eventUri, invitee });
  }

  const lots = await Lot.find({ 'buyers.email': email });
  for (const lot of lots) {
    // Respect an explicit opt-out; never resurrect that lot from a booking.
    if (lot.status === 'opted_out') continue;

    const alreadyMatchedSameEvent =
      lot.calendlyEventUri && eventUri && lot.calendlyEventUri === eventUri;

    const matchedRole = (lot.buyers.find((b) => normalizeEmail(b.email) === email) || {}).role || '';

    const priorStatus = lot.status;
    lot.status = 'scheduled';
    lot.calendlyEventUri = eventUri || lot.calendlyEventUri;
    lot.calendlyEvent = {
      name: ev.name || invitee.name || '',
      startTime: ev.start_time ? new Date(ev.start_time) : lot.calendlyEvent?.startTime || null,
      endTime: ev.end_time ? new Date(ev.end_time) : lot.calendlyEvent?.endTime || null,
      inviteeName: invitee.name || lot.calendlyEvent?.inviteeName || '',
      inviteeEmail: email,
      inviteeStatus: invitee.status || lot.calendlyEvent?.inviteeStatus || '',
      matchedBuyerRole: matchedRole,
      location: ev.location?.location || ev.location?.join_url || lot.calendlyEvent?.location || '',
      rescheduleUrl: invitee.reschedule_url || lot.calendlyEvent?.rescheduleUrl || '',
      cancelUrl: invitee.cancel_url || lot.calendlyEvent?.cancelUrl || '',
      lastSyncedAt: new Date(),
    };
    await lot.save();

    if (!alreadyMatchedSameEvent) {
      await MessageLog.create({
        project: lot.project,
        lot: lot._id,
        type: 'calendly',
        direction: 'in',
        to: email,
        subject: invitee.name || 'Calendly invitee.created',
        body: JSON.stringify(invitee).slice(0, 2000),
        status: 'received',
        providerId: eventUri,
        sentAt: new Date(),
      });
      if (priorStatus !== 'scheduled') {
        await logStatusChange({
          lot,
          project: lot.project,
          fromStatus: priorStatus,
          toStatus: 'scheduled',
          actor: 'calendly_sync',
          message: `Calendly webhook matched ${email}.`,
        });
      }
    }
  }

  if (lots.length === 0 && eventUri) {
    await CalendlyUnmatch.updateOne(
      { eventUri, inviteeEmail: email },
      {
        $set: { lastSeenAt: new Date() },
        $setOnInsert: {
          eventUri,
          eventName: payload?.payload?.scheduled_event?.name || '',
          eventStartTime: payload?.payload?.scheduled_event?.start_time
            ? new Date(payload.payload.scheduled_event.start_time)
            : null,
          inviteeEmail: email,
          inviteeName: invitee.name || '',
          inviteeStatus: invitee.status || '',
          status: 'unmatched',
        },
      },
      { upsert: true }
    );
  }

  return { matched: lots.length };
}

// Revert a lot that was scheduled because of a now-cancelled Calendly event so
// it re-enters the follow-up flow. We act ONLY on the lot tied to exactly this
// event URI (and only while it's still 'scheduled'). That keeps us correct for
// reschedules — Calendly fires canceled(old) + created(new), and whichever
// arrives first, the cancel only ever touches the lot still pointing at the old
// event. completed / opted_out lots and lots already moved to a new event are
// left untouched.
async function handleCancellation({ email, eventUri }) {
  if (!eventUri) return { matched: 0, canceled: 0 };

  const lots = await Lot.find({ 'buyers.email': email, calendlyEventUri: eventUri });
  let reverted = 0;
  for (const lot of lots) {
    if (lot.status !== 'scheduled') continue; // only un-schedule a scheduled lot

    lot.status = 'contacted';
    // Clear the appointment so the "scheduled" card disappears from the lot;
    // the cancellation stays recorded in the activity timeline below.
    lot.calendlyEventUri = '';
    lot.calendlyWarning = '';
    lot.calendlyEvent = buildLotCalendlyEvent({}, '', '');
    await lot.save();

    await MessageLog.create({
      project: lot.project,
      lot: lot._id,
      type: 'calendly',
      direction: 'in',
      to: email,
      subject: 'Calendly appointment canceled',
      body: `Invitee ${email} canceled event ${eventUri}`,
      status: 'received',
      providerId: eventUri,
      sentAt: new Date(),
    });
    await logStatusChange({
      lot,
      project: lot.project,
      fromStatus: 'scheduled',
      toStatus: 'contacted',
      actor: 'calendly_sync',
      message: `Calendly appointment canceled by ${email}.`,
    });
    reverted += 1;
  }

  // Mark any matching unmatched-queue rows resolved so the cancelled event
  // doesn't linger in the "needs mapping" list.
  await CalendlyUnmatch.updateOne(
    { eventUri, inviteeEmail: email },
    { $set: { status: 'ignored', lastSeenAt: new Date() } }
  ).catch(() => {});

  return { matched: lots.length, canceled: reverted };
}

module.exports = {
  verifyCalendly,
  syncAll,
  handleWebhook,
  // exported for the reconcile script + unit tests
  listEvents,
  listInvitees,
  collectOccurrences,
  findLotHits,
  buildLotCalendlyEvent,
  eventHasEnded,
  reconcileTargetStatus,
  normalizeEmail,
};

const axios = require('axios');
const env = require('../config/env');
const Rep = require('../models/Rep');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const MessageLog = require('../models/MessageLog');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');

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
    return { ok: true, message: `Connected as ${data.resource?.name || 'unknown'}` };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || err.message };
  }
}

function normalizeUserUri(raw) {
  if (!raw) return '';
  if (raw.startsWith('https://api.calendly.com/users/')) return raw;
  // If they gave a calendly.com/<slug>, we can't turn it into an API user URI
  // without a lookup; user should paste the API URI from /users/me.
  return raw;
}

async function listActiveEvents(userUri) {
  const c = client();
  if (!c) return [];
  const out = [];
  let url = `/scheduled_events?user=${encodeURIComponent(userUri)}&status=active&count=100`;
  while (url) {
    const { data } = await c.get(url);
    out.push(...(data.collection || []));
    url = data.pagination?.next_page ? data.pagination.next_page.replace(API_BASE, '') : null;
  }
  return out;
}

async function listInvitees(eventUri) {
  const c = client();
  if (!c) return [];
  const eventId = eventUri.split('/').pop();
  const { data } = await c.get(`/scheduled_events/${eventId}/invitees?count=100`);
  return data.collection || [];
}

// Poll Calendly for every rep with calendlyUser set, match invitees to lot
// buyers by email, flip matched lots to scheduled. If an email appears in more
// than one active event across all reps, mark calendlyWarning.
async function syncAll() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly not configured' };

  const reps = await Rep.find({ active: true, calendlyUser: { $ne: '' } });
  const emailOccurrences = new Map(); // email -> [{repId, eventUri, eventName, startTime}]
  const matched = [];

  for (const rep of reps) {
    try {
      const userUri = normalizeUserUri(rep.calendlyUser);
      const events = await listActiveEvents(userUri);
      for (const ev of events) {
        const invitees = await listInvitees(ev.uri);
        for (const inv of invitees) {
          const email = (inv.email || '').toLowerCase();
          if (!email) continue;
          const entry = {
            repId: rep._id,
            repName: rep.name,
            eventUri: ev.uri,
            eventName: ev.name,
            startTime: ev.start_time,
            inviteeName: inv.name || '',
            inviteeStatus: inv.status,
          };
          const arr = emailOccurrences.get(email) || [];
          arr.push(entry);
          emailOccurrences.set(email, arr);
        }
      }
    } catch (err) {
      console.warn(`[calendly] rep ${rep.name} failed:`, err.message);
    }
  }

  // Match emails to lots
  const emails = Array.from(emailOccurrences.keys());
  const matchedEmails = new Set();
  if (emails.length) {
    const lots = await Lot.find({ 'buyers.email': { $in: emails } });
    for (const lot of lots) {
      const hits = [];
      for (const b of lot.buyers) {
        if (!b.email) continue;
        const occ = emailOccurrences.get(b.email.toLowerCase());
        if (occ && occ.length) hits.push({ email: b.email, occurrences: occ });
      }
      if (!hits.length) continue;

      const multi = hits.some((h) => h.occurrences.length > 1);
      const firstHit = hits[0].occurrences[0];

      const wasUnscheduled = !['scheduled', 'booked'].includes(lot.status);
      if (wasUnscheduled) {
        lot.status = 'scheduled';
      }
      lot.calendlyEventUri = firstHit.eventUri || lot.calendlyEventUri;
      lot.calendlyWarning = multi
        ? `Invitee appears in multiple active Calendly events (${hits[0].occurrences.length}). Check for duplicates.`
        : '';

      if (firstHit.repId) lot.assignedRep = lot.assignedRep || firstHit.repId;

      await lot.save();

      await MessageLog.create({
        project: lot.project,
        lot: lot._id,
        rep: firstHit.repId || null,
        type: 'calendly',
        direction: 'in',
        to: hits[0].email,
        subject: firstHit.eventName || 'Calendly event',
        body: `Matched invitee ${hits[0].email} in event ${firstHit.eventUri}`,
        status: 'received',
        providerId: firstHit.eventUri,
        sentAt: new Date(),
      });

      for (const h of hits) matchedEmails.add(h.email.toLowerCase());
      matched.push({ lotId: String(lot._id), email: hits[0].email, multi });
    }
  }

  // Anything we saw that didn't match: upsert into CalendlyUnmatch so the UI
  // can surface them and let the user manually map to a lot. If the record
  // already exists we bump lastSeenAt but don't disturb a user decision
  // ('mapped' / 'ignored').
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
            rep: occ.repId || null,
            repName: occ.repName || '',
            status: 'unmatched',
          },
        },
        { upsert: true }
      );
      unmatchedCount += 1;
    }
  }

  const setting = await Setting.getSingleton();
  setting.lastCalendlySync = new Date();
  setting.calendlyHealth = { ok: true, checkedAt: new Date(), message: 'Sync ran' };
  await setting.save();

  return { ok: true, reps: reps.length, emailsSeen: emails.length, matched, unmatched: unmatchedCount };
}

// Handle a single webhook payload from Calendly (invitee.created).
async function handleWebhook(payload) {
  const invitee = payload?.payload || {};
  const email = (invitee.email || '').toLowerCase();
  const eventUri = invitee.event || payload?.payload?.scheduled_event?.uri || '';
  if (!email) return { matched: 0 };

  const lots = await Lot.find({ 'buyers.email': email });
  for (const lot of lots) {
    if (!['scheduled', 'booked'].includes(lot.status)) lot.status = 'scheduled';
    lot.calendlyEventUri = eventUri || lot.calendlyEventUri;
    await lot.save();
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
  }

  // Record unmatched invitees so they show up in the UI for manual mapping
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

module.exports = { verifyCalendly, syncAll, handleWebhook };

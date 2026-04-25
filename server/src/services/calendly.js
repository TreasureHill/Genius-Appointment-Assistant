const axios = require('axios');
const env = require('../config/env');
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
    return {
      ok: true,
      message: `Connected as ${data.resource?.name || 'unknown'}`,
      user: data.resource,
    };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || err.message };
  }
}

// Pull every scheduled event for the given user URI. Explicit time bounds
// because Calendly's default window can hide events; 30 days ago through
// 365 days ahead covers recent and upcoming.
async function listActiveEvents(userUri) {
  const c = client();
  if (!c) return [];
  const minStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const maxStart = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const out = [];
  let url =
    `/scheduled_events?user=${encodeURIComponent(userUri)}` +
    `&status=active&count=100` +
    `&min_start_time=${encodeURIComponent(minStart)}` +
    `&max_start_time=${encodeURIComponent(maxStart)}`;
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

// Sync the single owner's Calendly events: pull scheduled_events, match
// invitees to lot buyers by email, flip matches to 'scheduled'. Anything
// unmatched goes into CalendlyUnmatch for manual mapping.
async function syncAll() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly not configured (missing CALENDLY_TOKEN)' };

  const setting = await Setting.getSingleton();
  const userUri = setting.owner?.calendlyUri;
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
  const emailOccurrences = new Map();
  for (const ev of events) {
    let invitees = [];
    try {
      invitees = await listInvitees(ev.uri);
    } catch (err) {
      console.warn('[calendly] invitees fetch failed', ev.uri, err.message);
    }
    for (const inv of invitees) {
      const email = (inv.email || '').toLowerCase();
      if (!email) continue;
      const entry = {
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

  const emails = Array.from(emailOccurrences.keys());
  const matchedEmails = new Set();
  const matched = [];

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

      if (lot.status !== 'scheduled') lot.status = 'scheduled';
      lot.calendlyEventUri = firstHit.eventUri || lot.calendlyEventUri;
      lot.calendlyWarning = multi
        ? `Invitee appears in multiple active Calendly events (${hits[0].occurrences.length}). Check for duplicates.`
        : '';
      await lot.save();

      await MessageLog.create({
        project: lot.project,
        lot: lot._id,
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
    unmatched: unmatchedCount,
  };
}

// Handle a single webhook payload from Calendly (invitee.created).
async function handleWebhook(payload) {
  const invitee = payload?.payload || {};
  const email = (invitee.email || '').toLowerCase();
  const eventUri = invitee.event || payload?.payload?.scheduled_event?.uri || '';
  if (!email) return { matched: 0 };

  const lots = await Lot.find({ 'buyers.email': email });
  for (const lot of lots) {
    if (lot.status !== 'scheduled') lot.status = 'scheduled';
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

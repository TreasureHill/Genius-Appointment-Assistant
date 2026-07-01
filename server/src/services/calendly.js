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

// ---- Availability + booking (used by Aria's phone tools) ----

// Resolve the Event Type URI Aria offers over the phone: Settings → Aria
// first, then the env fallback. Returns '' when unset.
async function resolveEventTypeUri() {
  try {
    const setting = await Setting.getSingleton();
    if (setting.aria?.calendlyEventTypeUri) return setting.aria.calendlyEventTypeUri;
  } catch {
    /* fall through to env */
  }
  return env.calendly.eventTypeUri || '';
}

async function resolveTimezone() {
  try {
    const setting = await Setting.getSingleton();
    if (setting.aria?.timezone) return setting.aria.timezone;
  } catch {
    /* ignore */
  }
  return 'America/New_York';
}

// Human-friendly label for a slot, e.g. "Tue, Jul 8 at 2:00 PM EDT".
function formatSlotLabel(startTimeIso, timeZone = 'America/New_York') {
  const d = new Date(startTimeIso);
  if (!Number.isFinite(d.getTime())) return String(startTimeIso || '');
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

// Pull real open slots from Calendly's event_type_available_times endpoint.
// That endpoint only accepts a window of <= 7 days starting in the future, so
// we chunk `days` into <=7-day requests, walking forward until we've collected
// `limit` slots or run out the horizon. Default horizon is 60 days so an empty
// next week doesn't hide the next actual opening (Calendly caps this at the
// event type's own rolling scheduling window anyway). Chunks are chronological,
// so the soonest slots always come first.
// Returns { ok, message, slots: [{ startTime, label, schedulingUrl }] }.
async function listAvailableTimes({ eventTypeUri, days = 60, limit = 6, timeZone } = {}) {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected yet.', slots: [] };
  const uri = eventTypeUri || (await resolveEventTypeUri());
  if (!uri) {
    return {
      ok: false,
      message: 'No Calendly event type is configured for phone booking.',
      slots: [],
    };
  }
  const tz = timeZone || (await resolveTimezone());
  const slots = [];
  const CHUNK_DAYS = 7;
  // Start 2 minutes out — Calendly rejects a start_time that isn't in the future.
  let windowStart = new Date(Date.now() + 2 * 60 * 1000);
  const hardEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  try {
    while (windowStart < hardEnd && slots.length < limit) {
      const windowEnd = new Date(
        Math.min(windowStart.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, hardEnd.getTime())
      );
      const params = new URLSearchParams({
        event_type: uri,
        start_time: windowStart.toISOString(),
        end_time: windowEnd.toISOString(),
      });
      const { data } = await c.get(`/event_type_available_times?${params.toString()}`);
      for (const s of data.collection || []) {
        if (s.status && s.status !== 'available') continue;
        slots.push({
          startTime: s.start_time,
          label: formatSlotLabel(s.start_time, tz),
          schedulingUrl: s.scheduling_url || '',
        });
        if (slots.length >= limit) break;
      }
      windowStart = windowEnd;
    }
    return { ok: true, slots };
  } catch (err) {
    return {
      ok: false,
      message: err.response?.data?.message || err.message || 'Could not read Calendly availability.',
      slots,
    };
  }
}

// List the owner's Calendly event types so the UI can offer a picker instead
// of making the operator paste an API URI by hand. Resolves the user URI from
// Settings → Owner, the env fallback, or /users/me. Returns
// { ok, eventTypes: [{ uri, name, active, schedulingUrl, duration }] }.
async function listEventTypes() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected (missing CALENDLY_TOKEN).', eventTypes: [] };
  try {
    const setting = await Setting.getSingleton();
    let userUri = setting.owner?.calendlyUri || env.calendly.userUri;
    if (!userUri) {
      const me = await c.get('/users/me');
      userUri = me.data?.resource?.uri;
    }
    if (!userUri) {
      return { ok: false, message: 'Could not resolve your Calendly user. Set the Owner Calendly URI first.', eventTypes: [] };
    }
    const params = new URLSearchParams({ user: userUri, count: '100' });
    const out = [];
    let url = `/event_types?${params.toString()}`;
    while (url) {
      const { data } = await c.get(url);
      for (const e of data.collection || []) {
        out.push({
          uri: e.uri,
          name: e.name,
          active: e.active,
          schedulingUrl: e.scheduling_url || '',
          duration: e.duration || null,
        });
      }
      url = data.pagination?.next_page ? data.pagination.next_page.replace(API_BASE, '') : null;
    }
    return { ok: true, eventTypes: out };
  } catch (err) {
    return { ok: false, message: err.response?.data?.message || err.message, eventTypes: [] };
  }
}

// Actually book a slot on Calendly via the Scheduling API (Create Event
// Invitee). This creates a real scheduled event and triggers Calendly's own
// confirmations/calendar invite. Requires a paid plan + a token whose account
// can schedule (host/admin PAT or OAuth). `locationKind` is only needed when
// the event type requires a location choice (e.g. 'physical', 'outbound_call',
// 'zoom_conference', 'ask_invitee'); leave blank to use the event type default.
// Returns { ok, eventUri, resource } or { ok:false, message, status }.
async function bookOnCalendly({ eventTypeUri, startTimeIso, name, email, timezone, locationKind }) {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected.' };
  const uri = eventTypeUri || (await resolveEventTypeUri());
  if (!uri) return { ok: false, message: 'No Calendly event type is configured for phone booking.' };
  if (!email) return { ok: false, message: 'An email address is required to book.' };
  const start = new Date(startTimeIso);
  if (!Number.isFinite(start.getTime())) return { ok: false, message: 'Invalid start time.' };

  const payload = {
    event_type: uri,
    start_time: start.toISOString(), // ISO 8601 UTC with trailing Z
    invitee: {
      name: name || email,
      email,
      timezone: timezone || 'America/New_York',
    },
  };
  if (locationKind) payload.location = { kind: locationKind };

  try {
    const { data } = await c.post('/invitees', payload);
    const resource = data?.resource || data || {};
    return {
      ok: true,
      resource,
      eventUri: resource.event || resource.scheduled_event?.uri || resource.uri || '',
      rescheduleUrl: resource.reschedule_url || '',
      cancelUrl: resource.cancel_url || '',
    };
  } catch (err) {
    const body = err.response?.data || {};
    const detailMsg = Array.isArray(body.details) && body.details.length
      ? body.details.map((d) => `${d.parameter || ''} ${d.message || ''}`.trim()).join('; ')
      : '';
    return {
      ok: false,
      status: err.response?.status,
      message: detailMsg || body.message || body.title || err.message,
    };
  }
}

// Mint a single-use scheduling link for the event type. Used as the fallback
// confirmation link when a matched slot didn't carry its own scheduling_url.
// Returns the booking URL or ''.
async function createSchedulingLink(eventTypeUri) {
  const c = client();
  if (!c) return '';
  const uri = eventTypeUri || (await resolveEventTypeUri());
  if (!uri) return '';
  try {
    const { data } = await c.post('/scheduling_links', {
      owner: uri,
      owner_type: 'EventType',
      max_event_count: 1,
    });
    return data?.resource?.booking_url || '';
  } catch {
    return '';
  }
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

// Lowercased, whitespace-collapsed text for loose comparison.
function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Strip everything but letters/digits: "END Unit 6" -> "endunit6", "Lot #12-B"
// -> "lot12b". Lets us compare regardless of spacing/punctuation.
function compact(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Split into alphanumeric tokens: "B2 - END Unit 6" -> ["b2","end","unit","6"].
function tokenize(s) {
  return normalizeText(s).split(/[^a-z0-9]+/i).filter(Boolean);
}

// Pull the free-text the invitee typed into the Calendly booking questions.
function extractAnswerText(occ) {
  if (!occ) return '';
  if (occ.answerText) return occ.answerText;
  const qa = occ.questionsAndAnswers || occ.questions_and_answers || [];
  return qa.map((q) => q.answer).filter(Boolean).join(' ');
}

// Is the lot's project name present in what the invitee typed? Projects are
// distinctive, so a compact substring match is enough (guard tiny names).
function answerHasProject(answerCompact, projectName) {
  const p = compact(projectName);
  return p.length >= 2 && answerCompact.includes(p);
}

// Is the lot number present? Short/numeric lot numbers ("6") must appear as a
// whole token so they don't match "16"/"60"; distinctive ones (>=3 chars) may
// match as a substring ("endunit6").
function answerHasLotNumber(answerCompact, answerTokens, lotNumber) {
  const c = compact(lotNumber);
  if (!c) return false;
  if (answerTokens.has(c)) return true;
  return c.length >= 3 && answerCompact.includes(c);
}

// Find lots whose project name AND lot number both appear in the invitee's
// typed answer. Requiring BOTH keeps this high-confidence — the caller only
// auto-matches when exactly one lot comes back. `lots` items expose
// { lotNumber, projectName }. Pure.
function matchLotsByAnswer(answer, lots) {
  const answerCompact = compact(answer);
  if (!answerCompact) return [];
  const answerTokens = new Set(tokenize(answer));
  const out = [];
  for (const lot of lots) {
    if (!lot.lotNumber || !lot.projectName) continue;
    if (!answerHasProject(answerCompact, lot.projectName)) continue;
    if (!answerHasLotNumber(answerCompact, answerTokens, lot.lotNumber)) continue;
    out.push(lot);
  }
  return out;
}

// Significant name tokens for an occurrence — prefer the structured
// first/last name, fall back to splitting the full name. Drops 1-char initials.
function nameTokens(occ) {
  let toks = [occ.inviteeFirstName, occ.inviteeLastName]
    .flatMap((p) => tokenize(p))
    .filter((t) => t.length >= 2);
  if (toks.length < 2) {
    toks = tokenize(occ.inviteeName || occ.name || '').filter((t) => t.length >= 2);
  }
  return toks;
}

// Find lots that have a buyer whose name contains BOTH the invitee's first and
// last name. Needs at least a first + last to fire (a lone first name is too
// weak). Returns [{ lot, role }]. Caller auto-matches only on a unique hit.
function matchLotsByName(occ, lots) {
  const toks = nameTokens(occ);
  if (toks.length < 2) return [];
  const first = toks[0];
  const last = toks[toks.length - 1];
  const out = [];
  for (const lot of lots) {
    for (const b of lot.buyers || []) {
      const bn = compact(b.name);
      if (bn && bn.includes(first) && bn.includes(last)) {
        out.push({ lot, role: b.role });
        break;
      }
    }
  }
  return out;
}

// Prepare a Mongoose lot doc for the pure matchers above: flatten the bits they
// read and keep a handle back to the doc so the caller can save it.
function prepLotForMatch(doc) {
  return {
    doc,
    lotNumber: doc.lotNumber,
    projectName: doc.project?.name || '',
    buyers: doc.buyers || [],
  };
}

// Pick the single best lot for an unmatched occurrence using the typed
// project/lot answer first, then the buyer name. Only returns a match when the
// signal is unambiguous (exactly one candidate). `prepared` is an array of
// prepLotForMatch() results. Returns { lot, method, role } or null. Pure.
function matchUnmatchedOccurrence(occ, prepared) {
  const byAnswer = matchLotsByAnswer(extractAnswerText(occ), prepared);
  if (byAnswer.length === 1) {
    return { lot: byAnswer[0].doc, method: 'project/lot answer', role: '' };
  }
  const byName = matchLotsByName(occ, prepared);
  if (byName.length === 1) {
    return { lot: byName[0].lot.doc, method: 'buyer name', role: byName[0].role };
  }
  return null;
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
      const qa = Array.isArray(inv.questions_and_answers)
        ? inv.questions_and_answers.map((q) => ({ question: q.question || '', answer: q.answer || '' }))
        : [];
      const entry = {
        eventUri: ev.uri,
        eventName: ev.name,
        startTime: ev.start_time,
        endTime: ev.end_time,
        location: ev.location?.location || ev.location?.join_url || '',
        inviteeName: inv.name || '',
        inviteeFirstName: inv.first_name || '',
        inviteeLastName: inv.last_name || '',
        inviteeStatus: inv.status,
        rescheduleUrl: inv.reschedule_url || '',
        cancelUrl: inv.cancel_url || '',
        // What the invitee typed into the booking questions (e.g. the
        // "project name and lot number" prompt). Used as a matching signal when
        // their email isn't on any lot.
        questionsAndAnswers: qa,
        answerText: qa.map((q) => q.answer).filter(Boolean).join(' '),
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
  // email → matched lot _id, across both passes. Used at the end to clear any
  // stale rows this invitee left in the manual-mapping queue on a prior sync.
  const matchedEmailToLot = new Map();
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
      for (const h of hits) {
        matchedEmails.add(h.email.toLowerCase());
        matchedEmailToLot.set(h.email.toLowerCase(), lot._id);
      }

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

  // Pass 2: invitees whose email isn't on any lot. Auto-schedule a UNIQUE
  // pending/contacted lot using the project + lot number they typed into the
  // booking question, then their buyer name. Lower confidence than email, so we
  // only act on an unambiguous hit and never touch a lot that's already
  // scheduled / completed / opted_out.
  let signalMatched = 0;
  const unresolved = emails.filter((e) => !matchedEmails.has(e));
  if (unresolved.length) {
    const candidates = await Lot.find({ status: { $in: ['pending', 'contacted'] } }).populate(
      'project',
      'name'
    );
    const prepared = candidates.map(prepLotForMatch);
    // Guard against two different unknown-email invitees both resolving to the
    // same lot in one run — the first wins; the rest stay unmatched for manual
    // review rather than silently overwriting each other.
    const usedLotIds = new Set();
    for (const email of unresolved) {
      const occurrences = emailOccurrences.get(email) || [];
      // Most recent occurrence carries the event we'll attach to the lot.
      const occ = [...occurrences].sort(
        (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
      )[0];
      if (!occ) continue;
      const m = matchUnmatchedOccurrence(occ, prepared);
      if (!m) continue;
      const lot = m.lot;
      if (usedLotIds.has(String(lot._id))) continue;
      usedLotIds.add(String(lot._id));

      matchedEmails.add(email);
      matchedEmailToLot.set(email, lot._id);

      const priorStatus = lot.status;
      lot.status = 'scheduled';
      lot.calendlyEventUri = occ.eventUri || lot.calendlyEventUri;
      lot.calendlyWarning = `Auto-matched by ${m.method} (not email) — verify this is the right lot.`;
      lot.calendlyEvent = buildLotCalendlyEvent(occ, email, m.role);
      await lot.save();

      const projectId = lot.project?._id || lot.project;
      await MessageLog.create({
        project: projectId,
        lot: lot._id,
        type: 'calendly',
        direction: 'in',
        to: email,
        subject: occ.eventName || 'Calendly event',
        body: `Matched invitee ${email} to lot ${lot.lotNumber} by ${m.method} (answer: "${extractAnswerText(occ)}")`,
        status: 'received',
        providerId: occ.eventUri,
        sentAt: new Date(),
      });
      await logStatusChange({
        lot,
        project: projectId,
        fromStatus: priorStatus,
        toStatus: 'scheduled',
        actor: 'calendly_sync',
        message: `Calendly matched ${email} to ${occ.eventName || 'event'} by ${m.method}.`,
      });
      matched.push({ lotId: String(lot._id), email, method: m.method });
      signalMatched += 1;
    }
  }

  // Anyone we matched (either pass) may still have stale rows in the
  // manual-mapping queue from an earlier sync — resolve them so the list
  // reflects reality (they show under "Mapped", linked to the lot).
  for (const [email, lotId] of matchedEmailToLot) {
    await CalendlyUnmatch.updateMany(
      { inviteeEmail: email, status: 'unmatched' },
      { $set: { status: 'mapped', mappedLot: lotId, mappedAt: new Date() } }
    );
  }

  // Persist unmatched invitees for manual mapping in the UI
  let unmatchedCount = 0;
  for (const [email, occurrences] of emailOccurrences) {
    if (matchedEmails.has(email)) continue;
    for (const occ of occurrences) {
      await CalendlyUnmatch.updateOne(
        { eventUri: occ.eventUri, inviteeEmail: email },
        {
          // Refresh the typed answer + name on every sync so existing rows get
          // backfilled and the UI can show what the invitee entered.
          $set: {
            lastSeenAt: new Date(),
            answer: occ.answerText || '',
            inviteeName: occ.inviteeName || '',
            inviteeFirstName: occ.inviteeFirstName || '',
            inviteeLastName: occ.inviteeLastName || '',
          },
          $setOnInsert: {
            eventUri: occ.eventUri,
            eventName: occ.eventName || '',
            eventStartTime: occ.startTime ? new Date(occ.startTime) : null,
            inviteeEmail: email,
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
    bySignal: signalMatched,
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
    // Build an occurrence from the webhook payload so the same matchers used by
    // the poll can run here.
    const qa = Array.isArray(invitee.questions_and_answers)
      ? invitee.questions_and_answers.map((q) => ({ question: q.question || '', answer: q.answer || '' }))
      : [];
    const occ = {
      eventUri,
      eventName: ev.name || '',
      startTime: ev.start_time,
      endTime: ev.end_time,
      location: ev.location?.location || ev.location?.join_url || '',
      inviteeName: invitee.name || '',
      inviteeFirstName: invitee.first_name || '',
      inviteeLastName: invitee.last_name || '',
      inviteeStatus: invitee.status || '',
      rescheduleUrl: invitee.reschedule_url || '',
      cancelUrl: invitee.cancel_url || '',
      questionsAndAnswers: qa,
      answerText: qa.map((q) => q.answer).filter(Boolean).join(' '),
    };

    // No email match — try the project/lot the invitee typed, then their name.
    const candidates = await Lot.find({ status: { $in: ['pending', 'contacted'] } }).populate(
      'project',
      'name'
    );
    const m = matchUnmatchedOccurrence(occ, candidates.map(prepLotForMatch));
    if (m) {
      const lot = m.lot;
      const priorStatus = lot.status;
      lot.status = 'scheduled';
      lot.calendlyEventUri = eventUri || lot.calendlyEventUri;
      lot.calendlyWarning = `Auto-matched by ${m.method} (not email) — verify this is the right lot.`;
      lot.calendlyEvent = buildLotCalendlyEvent(occ, email, m.role);
      await lot.save();

      const projectId = lot.project?._id || lot.project;
      await MessageLog.create({
        project: projectId,
        lot: lot._id,
        type: 'calendly',
        direction: 'in',
        to: email,
        subject: occ.eventName || 'Calendly invitee.created',
        body: `Webhook matched ${email} to lot ${lot.lotNumber} by ${m.method} (answer: "${extractAnswerText(occ)}")`,
        status: 'received',
        providerId: eventUri,
        sentAt: new Date(),
      });
      if (priorStatus !== 'scheduled') {
        await logStatusChange({
          lot,
          project: projectId,
          fromStatus: priorStatus,
          toStatus: 'scheduled',
          actor: 'calendly_sync',
          message: `Calendly webhook matched ${email} by ${m.method}.`,
        });
      }
      // Clear any stale queue rows for this invitee.
      await CalendlyUnmatch.updateMany(
        { inviteeEmail: email, status: 'unmatched' },
        { $set: { status: 'mapped', mappedLot: lot._id, mappedAt: new Date() } }
      );
      return { matched: 1, method: m.method };
    }

    await CalendlyUnmatch.updateOne(
      { eventUri, inviteeEmail: email },
      {
        $set: {
          lastSeenAt: new Date(),
          answer: occ.answerText || '',
          inviteeName: invitee.name || '',
          inviteeFirstName: invitee.first_name || '',
          inviteeLastName: invitee.last_name || '',
        },
        $setOnInsert: {
          eventUri,
          eventName: occ.eventName || '',
          eventStartTime: ev.start_time ? new Date(ev.start_time) : null,
          inviteeEmail: email,
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
  // availability + booking (Aria phone tools)
  resolveEventTypeUri,
  resolveTimezone,
  formatSlotLabel,
  listAvailableTimes,
  createSchedulingLink,
  bookOnCalendly,
  listEventTypes,
  // exported for the reconcile script + unit tests
  listEvents,
  listInvitees,
  collectOccurrences,
  findLotHits,
  buildLotCalendlyEvent,
  eventHasEnded,
  reconcileTargetStatus,
  normalizeEmail,
  // matching helpers (project/lot answer + buyer name)
  normalizeText,
  compact,
  tokenize,
  extractAnswerText,
  matchLotsByAnswer,
  matchLotsByName,
  matchUnmatchedOccurrence,
  prepLotForMatch,
};

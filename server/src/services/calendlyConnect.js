const axios = require('axios');
const crypto = require('crypto');
const env = require('../config/env');
const Setting = require('../models/Setting');
const secrets = require('./secrets');
const { encrypt } = require('./secretBox');
const { API_BASE, client, clearAvailabilityCache, formatSlotLabel } = require('./calendly');

// Calendly as an API connection managed from the UI (Integrations → Calendly)
// plus the reads the inbox scheduler needs: a week of open times for any
// event type, and the meetings already booked with one invitee.

function clientWithToken(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
}

function describeError(err) {
  const body = err?.response?.data || {};
  const details = Array.isArray(body.details) ? body.details.map((d) => d.message).filter(Boolean).join('; ') : '';
  return details || body.message || body.title || err?.message || 'Calendly request failed';
}

function accountFromUser(u = {}) {
  return {
    name: u.name || '',
    email: u.email || '',
    uri: u.uri || '',
    organizationUri: u.current_organization || '',
    schedulingUrl: u.scheduling_url || '',
    avatarUrl: u.avatar_url || '',
    timezone: u.timezone || '',
  };
}

// Check a token (the stored one when omitted) against /users/me.
async function verifyToken(token) {
  const c = token ? clientWithToken(token) : client();
  if (!c) return { ok: false, message: 'No Calendly token connected.' };
  try {
    const { data } = await c.get('/users/me');
    return { ok: true, account: accountFromUser(data.resource), message: `Connected as ${data.resource?.name || 'unknown'}` };
  } catch (err) {
    const status = err?.response?.status;
    return {
      ok: false,
      message: status === 401 ? 'Calendly rejected this token (401). Create a new Personal Access Token and try again.' : describeError(err),
    };
  }
}

// Save a token after verifying it. Points Settings → Owner's Calendly URI at
// the connected account (the 30-minute poll reads it) and fills the booking
// link / name when blank, so {{owner.calendlyUrl}} works straight away.
async function connect(token) {
  const verify = await verifyToken(String(token || '').trim());
  if (!verify.ok) return verify;
  const s = await Setting.getSingleton();
  s.integrations = s.integrations || {};
  s.integrations.calendly = s.integrations.calendly || {};
  s.integrations.calendly.tokenEnc = encrypt(String(token).trim());
  s.integrations.calendly.connectedAt = new Date();
  s.integrations.calendly.account = verify.account;
  s.owner = s.owner || {};
  const filled = [];
  if (!s.owner.calendlyUri || s.owner.calendlyUri !== verify.account.uri) {
    if (!s.owner.calendlyUri) filled.push('owner Calendly URI');
    s.owner.calendlyUri = verify.account.uri;
  }
  if (!s.owner.calendlyUrl && verify.account.schedulingUrl) {
    s.owner.calendlyUrl = verify.account.schedulingUrl;
    filled.push('booking link');
  }
  if (!s.owner.name && verify.account.name) s.owner.name = verify.account.name;
  s.calendlyHealth = { ok: true, checkedAt: new Date(), message: verify.message };
  await s.save();
  await secrets.loadSecrets();
  clearAvailabilityCache();
  return { ...verify, filled };
}

async function disconnect() {
  const s = await Setting.getSingleton();
  if (s.integrations?.calendly) {
    s.integrations.calendly.tokenEnc = '';
    s.integrations.calendly.connectedAt = null;
  }
  await s.save();
  await secrets.loadSecrets();
  clearAvailabilityCache();
}

// Re-test whatever token is active and refresh the stored account snapshot.
async function refreshAccount() {
  const verify = await verifyToken();
  const s = await Setting.getSingleton();
  s.calendlyHealth = { ok: verify.ok, checkedAt: new Date(), message: verify.message };
  if (verify.ok) {
    s.integrations = s.integrations || {};
    s.integrations.calendly = s.integrations.calendly || {};
    s.integrations.calendly.account = verify.account;
    if (!s.owner?.calendlyUri) s.owner.calendlyUri = verify.account.uri;
  }
  await s.save();
  return verify;
}

async function activeAccount() {
  const s = await Setting.getSingleton();
  const acct = s.integrations?.calendly?.account;
  if (acct?.uri && acct?.organizationUri) return acct;
  const verify = await verifyToken();
  return verify.ok ? verify.account : null;
}

// ---- Webhook subscriptions (Calendly → /api/webhooks/calendly) ----

async function webhookTarget() {
  let secret = secrets.calendlyWebhookSecret();
  if (!secret) {
    // No CALENDLY_WEBHOOK_SECRET in .env: mint one and keep it in Settings.
    secret = crypto.randomBytes(18).toString('hex');
    const s = await Setting.getSingleton();
    s.integrations.calendly.webhookSecret = secret;
    await s.save();
    await secrets.loadSecrets();
  }
  const base = String(env.appUrl || '').replace(/\/+$/, '');
  return { url: `${base}/api/webhooks/calendly?secret=${encodeURIComponent(secret)}`, base };
}

function sameEndpoint(a, b) {
  return String(a || '').split('?')[0].replace(/\/+$/, '') === String(b || '').split('?')[0].replace(/\/+$/, '');
}

async function listWebhooks() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected.', webhooks: [] };
  const acct = await activeAccount();
  if (!acct) return { ok: false, message: 'Could not read your Calendly account.', webhooks: [] };
  try {
    const params = new URLSearchParams({ organization: acct.organizationUri, user: acct.uri, scope: 'user', count: '100' });
    const { data } = await c.get(`/webhook_subscriptions?${params.toString()}`);
    const target = await webhookTarget();
    const webhooks = (data.collection || []).map((w) => ({
      uri: w.uri,
      id: String(w.uri || '').split('/').pop(),
      // Never echo the ?secret= back to the browser.
      url: String(w.callback_url || '').split('?')[0],
      events: w.events || [],
      state: w.state || '',
      createdAt: w.created_at || null,
      ours: sameEndpoint(w.callback_url, target.url),
    }));
    return { ok: true, webhooks, targetUrl: target.url.split('?')[0] };
  } catch (err) {
    const status = err?.response?.status;
    return {
      ok: false,
      message: status === 403 ? 'Calendly webhooks need a paid Calendly plan (Standard or higher).' : describeError(err),
      webhooks: [],
    };
  }
}

async function registerWebhook() {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected.' };
  const acct = await activeAccount();
  if (!acct) return { ok: false, message: 'Could not read your Calendly account.' };
  const target = await webhookTarget();
  if (/localhost|127\.0\.0\.1/.test(target.base)) {
    return { ok: false, message: `APP_URL is ${target.base} — Calendly can't reach a local address. Set APP_URL to your public URL first.` };
  }
  const existing = await listWebhooks();
  if (existing.ok && existing.webhooks.some((w) => w.ours && w.state === 'active')) {
    return { ok: true, message: 'This app is already subscribed.', already: true };
  }
  try {
    const { data } = await c.post('/webhook_subscriptions', {
      url: target.url,
      events: ['invitee.created', 'invitee.canceled'],
      organization: acct.organizationUri,
      user: acct.uri,
      scope: 'user',
    });
    return { ok: true, message: 'Webhook registered.', uri: data?.resource?.uri || '' };
  } catch (err) {
    const status = err?.response?.status;
    return {
      ok: false,
      message: status === 403 ? 'Calendly webhooks need a paid Calendly plan (Standard or higher).' : describeError(err),
    };
  }
}

async function deleteWebhook(id) {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected.' };
  try {
    await c.delete(`/webhook_subscriptions/${encodeURIComponent(id)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

// ---- Scheduler reads ----

const DAY_MS = 24 * 60 * 60 * 1000;

// Open times for one event type between `start` and `end` (Calendly answers
// at most 7 days per request, so a longer range is split; a start in the past
// is moved to "two minutes from now" because Calendly rejects it).
async function availableTimesInRange({ eventTypeUri, start, end, timeZone }) {
  const c = client();
  if (!c) return { ok: false, message: 'Calendly is not connected.', slots: [] };
  if (!eventTypeUri) return { ok: false, message: 'Pick an event type.', slots: [] };
  const now = Date.now() + 2 * 60 * 1000;
  let from = Math.max(new Date(start).getTime() || now, now);
  const to = new Date(end).getTime();
  if (!Number.isFinite(to) || to <= from) return { ok: true, slots: [] };
  const windows = [];
  while (from < to) {
    const winEnd = Math.min(from + 7 * DAY_MS, to);
    windows.push([from, winEnd]);
    from = winEnd;
  }
  try {
    const results = await Promise.all(
      windows.map(async ([a, b]) => {
        const params = new URLSearchParams({
          event_type: eventTypeUri,
          start_time: new Date(a).toISOString(),
          end_time: new Date(b).toISOString(),
        });
        const { data } = await c.get(`/event_type_available_times?${params.toString()}`);
        return data.collection || [];
      })
    );
    const slots = results
      .flat()
      .filter((s) => !s.status || s.status === 'available')
      .map((s) => ({
        startTime: s.start_time,
        label: formatSlotLabel(s.start_time, timeZone || 'America/New_York'),
        schedulingUrl: s.scheduling_url || '',
        spots: s.invitees_remaining ?? null,
      }))
      .sort((x, y) => new Date(x.startTime) - new Date(y.startTime));
    return { ok: true, slots };
  } catch (err) {
    return { ok: false, message: describeError(err), slots: [] };
  }
}

// Find the first week (from `from`) with an opening, looking up to `maxDays`
// ahead — powers the scheduler's "Next available" jump.
async function nextAvailable({ eventTypeUri, from, timeZone, maxDays = 60 }) {
  let start = new Date(from || Date.now()).getTime();
  const stop = start + maxDays * DAY_MS;
  while (start < stop) {
    const end = Math.min(start + 14 * DAY_MS, stop);
    // eslint-disable-next-line no-await-in-loop
    const r = await availableTimesInRange({ eventTypeUri, start, end, timeZone });
    if (!r.ok) return r;
    if (r.slots.length) return { ok: true, slot: r.slots[0] };
    start = end;
  }
  return { ok: true, slot: null };
}

// Meetings already on the calendar with this invitee (upcoming first, then the
// most recent past one), so the scheduler can warn before double-booking.
async function eventsForInvitee(email) {
  const c = client();
  if (!c || !email) return { ok: false, events: [] };
  const acct = await activeAccount();
  if (!acct) return { ok: false, events: [] };
  try {
    const params = new URLSearchParams({
      user: acct.uri,
      invitee_email: String(email).toLowerCase(),
      count: '20',
      sort: 'start_time:desc',
      min_start_time: new Date(Date.now() - 180 * DAY_MS).toISOString(),
    });
    const { data } = await c.get(`/scheduled_events?${params.toString()}`);
    const events = (data.collection || []).map((e) => ({
      uri: e.uri,
      name: e.name || '',
      status: e.status || '',
      startTime: e.start_time,
      endTime: e.end_time,
      location: e.location?.location || e.location?.join_url || e.location?.type || '',
      joinUrl: e.location?.join_url || '',
      upcoming: new Date(e.start_time).getTime() > Date.now(),
    }));
    return { ok: true, events };
  } catch (err) {
    return { ok: false, message: describeError(err), events: [] };
  }
}

module.exports = {
  verifyToken,
  connect,
  disconnect,
  refreshAccount,
  activeAccount,
  listWebhooks,
  registerWebhook,
  deleteWebhook,
  availableTimesInRange,
  nextAvailable,
  eventsForInvitee,
  describeError,
};

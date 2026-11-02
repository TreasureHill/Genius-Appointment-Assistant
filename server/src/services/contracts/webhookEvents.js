const WebhookEvent = require('../../models/WebhookEvent');

// Idempotency for incoming Stripe / DocuSign webhooks. Each provider event is
// claimed in WebhookEvent (unique {provider, eventId}) before it is processed:
//
//   new event                       → claim it, process          (→ 200 / 500)
//   already processed / ignored     → duplicate, do nothing      (→ 200)
//   'processing' and < 5 min old    → someone else is on it      (→ 409, provider retries later)
//   'failed', or 'processing' stale → re-claim (CAS) and process again
//
// Processing is synchronous inside the request; a 500 makes the provider
// retry, and the Stripe reconciler retries 'failed' rows too.

const STALE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;

// Pure: what to do with an event that already has a row.
function decideOnExisting(existing, now = new Date()) {
  if (!existing) return 'process';
  if (existing.status === 'processed' || existing.status === 'ignored') return 'duplicate';
  if (existing.status === 'processing') {
    const started = existing.startedAt ? new Date(existing.startedAt).getTime() : 0;
    return now.getTime() - started < STALE_MS ? 'in_progress' : 'retry';
  }
  return 'retry'; // failed
}

// Claim an event for processing.
// Returns { action: 'process' | 'duplicate' | 'in_progress', doc }.
async function claimWebhookEvent({ provider, eventId, type = '', objectId = '' }, now = new Date()) {
  try {
    const doc = await WebhookEvent.create({
      provider,
      eventId,
      type,
      objectId,
      status: 'processing',
      attempts: 1,
      receivedAt: now,
      startedAt: now,
    });
    return { action: 'process', doc };
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  const existing = await WebhookEvent.findOne({ provider, eventId }).lean();
  const decision = decideOnExisting(existing, now);
  if (decision !== 'retry') return { action: decision === 'process' ? 'in_progress' : decision, doc: existing };
  // Compare-and-set on the state we just read so two retries can't both win.
  const doc = await WebhookEvent.findOneAndUpdate(
    { _id: existing._id, status: existing.status, startedAt: existing.startedAt },
    { $set: { status: 'processing', startedAt: now, error: '' }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  return doc ? { action: 'process', doc } : { action: 'in_progress', doc: existing };
}

async function markWebhookProcessed(provider, eventId, { ignored = false } = {}) {
  await WebhookEvent.updateOne(
    { provider, eventId },
    { $set: { status: ignored ? 'ignored' : 'processed', processedAt: new Date(), error: '' } }
  );
}

async function markWebhookFailed(provider, eventId, err) {
  // Short message only — never the payload.
  const message = String((err && err.message) || err || 'failed').slice(0, 500);
  await WebhookEvent.updateOne({ provider, eventId }, { $set: { status: 'failed', error: message } });
}

// Claim → run handler → mark. Returns { status, body } for the HTTP reply.
// handler() resolves to a result object; { ignored: <reason> } marks the row
// 'ignored' (still a 200 so the provider stops retrying).
async function processWebhookEvent(meta, handler) {
  const { provider, eventId } = meta;
  const claim = await claimWebhookEvent(meta);
  if (claim.action === 'duplicate') return { status: 200, body: { ok: true, duplicate: true } };
  if (claim.action === 'in_progress') return { status: 409, body: { error: 'in_progress' } };
  try {
    const result = (await handler()) || {};
    await markWebhookProcessed(provider, eventId, { ignored: Boolean(result.ignored) });
    return { status: 200, body: { ok: true, ...pickSafe(result) } };
  } catch (err) {
    console.error(`[webhook:${provider}] ${meta.type || ''} ${eventId} failed:`, err.message);
    await markWebhookFailed(provider, eventId, err).catch(() => {});
    return { status: 500, body: { ok: false, error: 'processing_failed' } };
  }
}

// Only echo small scalar fields back to the provider.
function pickSafe(result) {
  const out = {};
  for (const [k, v] of Object.entries(result || {})) {
    if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

// For the Stripe reconciler: rows worth another go (failed, or stuck in
// processing past the stale window), oldest first.
async function listRetryableWebhookEvents({ provider, limit = 50, now = new Date() } = {}) {
  const q = {
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ status: 'failed' }, { status: 'processing', startedAt: { $lt: new Date(now.getTime() - STALE_MS) } }],
  };
  if (provider) q.provider = provider;
  return WebhookEvent.find(q).sort({ receivedAt: 1 }).limit(limit).lean();
}

// Re-run a row from listRetryableWebhookEvents through `handler` with the same
// claim semantics as a live delivery.
async function retryWebhookEvent(row, handler) {
  return processWebhookEvent({ provider: row.provider, eventId: row.eventId, type: row.type, objectId: row.objectId }, handler);
}

module.exports = {
  STALE_MS,
  MAX_ATTEMPTS,
  decideOnExisting,
  claimWebhookEvent,
  markWebhookProcessed,
  markWebhookFailed,
  processWebhookEvent,
  listRetryableWebhookEvents,
  retryWebhookEvent,
};

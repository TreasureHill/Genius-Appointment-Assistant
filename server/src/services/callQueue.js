// Sequential Aria call queue.
//
// enqueue() adds lots; advance() dials the next queued lot but only when no
// call is in flight — so calls happen strictly one at a time, each starting
// after the previous ends. A call "ends" when the lot's call.status leaves
// 'calling', which happens either via the post-call webhook (fast path) or via
// reconcileActive() polling ElevenLabs (fallback when the webhook isn't set up).
//
// Concurrency: this app runs as a single Node process, so a module-level lock
// is enough to keep advance() from dispatching two calls at once. The DB check
// for an active 'calling' item is the durable backstop.

const CallQueueItem = require('../models/CallQueueItem');
const Lot = require('../models/Lot');
const ariaCall = require('./ariaCall');
const elevenlabs = require('./elevenlabs');

const TERMINAL_LOT_CALL = ['completed', 'voicemail', 'no_answer', 'failed'];
// Per-lot dispatch failures: mark the item failed and move on. A global config
// failure (not_dispatchable) instead pauses the queue so we don't drain it.
const PER_LOT_ERROR_CODES = new Set([
  'lot_not_found',
  'lot_opted_out',
  'no_callable_buyer',
  'buyer_missing_phone',
  'agent_not_configured',
  'agent_phone_number_not_configured',
]);

let advancing = false;

// Add lots to the queue. Skips opted-out lots, lots with no callable buyer, and
// lots already queued/calling. Returns { queued: [ids], skipped: [{lotId,reason}] }.
async function enqueue(lotIds, { buyerRole = '' } = {}) {
  const ids = Array.isArray(lotIds) ? lotIds : [];
  const lots = await Lot.find({ _id: { $in: ids } })
    .select('_id project status buyers')
    .lean();
  const queued = [];
  const skipped = [];
  for (const lot of lots) {
    const lotId = String(lot._id);
    if (lot.status === 'opted_out') {
      skipped.push({ lotId, reason: 'opted_out' });
      continue;
    }
    const callable = (lot.buyers || []).some((b) => b.phone && !b.optedOut);
    if (!callable) {
      skipped.push({ lotId, reason: 'no_phone' });
      continue;
    }
    const existing = await CallQueueItem.findOne({
      lot: lot._id,
      status: { $in: ['queued', 'calling'] },
    }).lean();
    if (existing) {
      skipped.push({ lotId, reason: 'already_queued' });
      continue;
    }
    await CallQueueItem.create({
      lot: lot._id,
      project: lot.project,
      status: 'queued',
      buyerRole,
    });
    await Lot.updateOne(
      { _id: lot._id, 'call.status': { $ne: 'calling' } },
      { $set: { 'call.status': 'queued' } }
    );
    queued.push(lotId);
  }
  return { queued, skipped };
}

// Best-effort: if a call is in flight but the webhook hasn't updated the lot,
// poll ElevenLabs. When the conversation is finished, fold the result onto the
// lot (same path as the webhook, idempotent) so the queue can proceed.
async function reconcileActive() {
  const active = await CallQueueItem.findOne({ status: 'calling' }).sort({ createdAt: 1 });
  if (!active) return;
  const lot = await Lot.findById(active.lot).select('call').lean();
  const st = lot?.call?.status;
  if (st && TERMINAL_LOT_CALL.includes(st)) return; // webhook already handled it
  const cid = active.conversationId || lot?.call?.conversationId;
  if (!cid) return;

  const conv = await elevenlabs.fetchConversation(cid);
  if (!conv) return;
  const convStatus = String(conv.status || '').toLowerCase();
  if (!['done', 'completed', 'failed', 'processed'].includes(convStatus)) return; // still talking

  const normalised = elevenlabs.normalisePostCallPayload(conv);
  normalised.lotId = String(active.lot); // we already know the lot
  if (!normalised.conversationId) normalised.conversationId = cid;
  await ariaCall.applyPostCall(normalised);
}

// Drive the queue: close out a finished active call, then dial the next queued
// lot (if nothing is in flight). Dispatches at most one new call per invocation.
async function advance() {
  if (advancing) return { skipped: 'busy' };
  advancing = true;
  try {
    // 1. Reconcile the active call, if any.
    const active = await CallQueueItem.findOne({ status: 'calling' }).sort({ createdAt: 1 });
    if (active) {
      const lot = await Lot.findById(active.lot).select('call').lean();
      const st = lot?.call?.status;
      if (st === 'calling' || st === 'queued') {
        return { waiting: String(active.lot) }; // still in progress — hold
      }
      active.status = st === 'failed' ? 'failed' : 'completed';
      active.outcome = st || '';
      active.endedAt = new Date();
      await active.save();
    }

    // Never start a queued call while ANY call is in flight — including a
    // manual "Call now" placed outside the queue.
    const anyCalling = await Lot.exists({ 'call.status': 'calling' });
    if (anyCalling) return { waiting: 'call_in_flight' };

    // 2. Dial the next queued lot. Skip past per-lot failures within this tick.
    for (;;) {
      const next = await CallQueueItem.findOne({ status: 'queued' }).sort({ createdAt: 1 });
      if (!next) return { idle: true };
      try {
        const r = await ariaCall.dispatchCall({
          lotId: next.lot,
          buyerRole: next.buyerRole || undefined,
        });
        next.status = 'calling';
        next.conversationId = r.conversationId || '';
        next.startedAt = new Date();
        await next.save();
        return { started: String(next.lot), conversationId: r.conversationId };
      } catch (err) {
        if (err.code === 'not_dispatchable') {
          // Aria not configured yet — leave the queue intact and retry later.
          return { paused: 'not_dispatchable' };
        }
        next.status = 'failed';
        next.error = err.code || err.message || 'dispatch_failed';
        next.endedAt = new Date();
        await next.save();
        await Lot.updateOne(
          { _id: next.lot, 'call.status': 'queued' },
          { $set: { 'call.status': 'idle' } }
        );
        // loop to try the following queued item
      }
    }
  } finally {
    advancing = false;
  }
}

// Snapshot for the UI: the active call, the pending queue (in order), and counts.
async function getStatus() {
  const [active, pending, counts] = await Promise.all([
    CallQueueItem.findOne({ status: 'calling' }).populate('lot', 'lotNumber').lean(),
    CallQueueItem.find({ status: 'queued' }).sort({ createdAt: 1 }).populate('lot', 'lotNumber').lean(),
    CallQueueItem.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = {};
  for (const c of counts) byStatus[c._id] = c.n;
  return {
    active: active || null,
    pending,
    queuedCount: pending.length,
    activeCount: active ? 1 : 0,
    byStatus,
  };
}

// Cancel everything still queued (not the in-flight call). Resets those lots'
// call badge back to idle.
async function clear() {
  const toCancel = await CallQueueItem.find({ status: 'queued' }).select('lot').lean();
  const lotIds = toCancel.map((i) => i.lot);
  const r = await CallQueueItem.updateMany(
    { status: 'queued' },
    { $set: { status: 'cancelled', endedAt: new Date() } }
  );
  if (lotIds.length) {
    await Lot.updateMany(
      { _id: { $in: lotIds }, 'call.status': 'queued' },
      { $set: { 'call.status': 'idle' } }
    );
  }
  return { cancelled: r.modifiedCount || 0 };
}

module.exports = { enqueue, advance, reconcileActive, getStatus, clear };

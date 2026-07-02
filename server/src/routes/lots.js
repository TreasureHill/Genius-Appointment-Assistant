const express = require('express');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const LotEvent = require('../models/LotEvent');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast, bumpReminderCount } = require('../services/enqueue');
const { logStatusChange } = require('../services/lotEventLogger');
const elevenlabs = require('../services/elevenlabs');
const ariaCall = require('../services/ariaCall');

const router = express.Router();

router.get('/', async (req, res) => {
  const { project, projects, status, q, limit = 200 } = req.query;
  const filter = {};
  if (projects) {
    const ids = String(projects).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 1) filter.project = ids[0];
    else if (ids.length > 1) filter.project = { $in: ids };
  } else if (project) {
    filter.project = project;
  }
  if (status) filter.status = status;
  if (q) {
    const r = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { lotNumber: r },
      { address: r },
      { 'buyers.name': r },
      { 'buyers.email': r },
      { 'buyers.phone': r },
    ];
  }
  const lots = await Lot.find(filter)
    .populate('project', 'name')
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();

  // Attach per-lot count of currently-pending Outbox rows so the board can
  // surface "X queued" without a second round-trip.
  if (lots.length) {
    const lotIds = lots.map((l) => l._id);
    const counts = await Outbox.aggregate([
      { $match: { lot: { $in: lotIds }, status: { $in: ['pending', 'sending'] } } },
      { $group: { _id: '$lot', n: { $sum: 1 } } },
    ]);
    const map = new Map(counts.map((c) => [String(c._id), c.n]));
    for (const l of lots) l.pendingMessages = map.get(String(l._id)) || 0;

    // Per-lot communication breakdown (by MessageLog type) so the board can
    // show which channels have been used with small icons.
    const commsRows = await MessageLog.aggregate([
      { $match: { lot: { $in: lotIds } } },
      { $group: { _id: { lot: '$lot', type: '$type' }, n: { $sum: 1 } } },
    ]);
    const commsMap = new Map();
    for (const r of commsRows) {
      const lid = String(r._id.lot);
      const entry = commsMap.get(lid) || {};
      entry[r._id.type] = r.n;
      commsMap.set(lid, entry);
    }
    for (const l of lots) l.comms = commsMap.get(String(l._id)) || {};
  }

  res.json(lots);
});

router.get('/:id', async (req, res) => {
  const lot = await Lot.findById(req.params.id).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });
  const [history, queued, events] = await Promise.all([
    MessageLog.find({ lot: lot._id }).sort({ createdAt: -1 }).limit(200).lean(),
    Outbox.find({ lot: lot._id, status: { $in: ['pending', 'sending'] } })
      .sort({ sendAfter: 1 })
      .lean(),
    LotEvent.find({ lot: lot._id }).sort({ createdAt: -1 }).limit(200).lean(),
  ]);
  res.json({ lot, history, queued, events });
});

router.post('/', async (req, res) => {
  const { project, lotNumber, address, buyers = [], status = 'pending', notes = '' } = req.body || {};
  if (!project || !lotNumber) return res.status(400).json({ error: 'project_and_lotNumber_required' });
  try {
    const lot = await Lot.create({ project, lotNumber, address, buyers, status, notes });
    res.status(201).json(lot);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'duplicate_lot_number' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const allowed = ['lotNumber', 'address', 'buyers', 'status', 'notes', 'reminderCount'];
  const update = {};
  for (const k of allowed) if (k in req.body) update[k] = req.body[k];

  const before = await Lot.findById(req.params.id).select('status').lean();
  if (!before) return res.status(404).json({ error: 'not_found' });

  const lot = await Lot.findByIdAndUpdate(req.params.id, update, { new: true }).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });

  if ('status' in update && update.status !== before.status) {
    await logStatusChange({
      lot,
      project: lot.project._id,
      fromStatus: before.status,
      toStatus: lot.status,
      actor: 'user',
      message: 'Status changed via lot editor.',
    });
  }

  // Cancel any pending outbox rows if lot is now stopped
  if (Lot.STOP_STATUSES.includes(lot.status)) {
    await Outbox.updateMany(
      { lot: lot._id, status: 'pending' },
      { $set: { status: 'cancelled', lastError: `lot status changed to ${lot.status}` } }
    );
  }
  res.json(lot);
});

router.post('/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!Lot.STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const before = await Lot.findById(req.params.id).select('status project').lean();
  if (!before) return res.status(404).json({ error: 'not_found' });
  const lot = await Lot.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!lot) return res.status(404).json({ error: 'not_found' });
  if (status !== before.status) {
    await logStatusChange({
      lot,
      project: before.project,
      fromStatus: before.status,
      toStatus: status,
      actor: 'user',
      message: 'Quick status change.',
    });
  }
  if (Lot.STOP_STATUSES.includes(status)) {
    await Outbox.updateMany(
      { lot: lot._id, status: 'pending' },
      { $set: { status: 'cancelled', lastError: `lot status changed to ${status}` } }
    );
  }
  res.json(lot);
});

router.delete('/:id', async (req, res) => {
  const lot = await Lot.findByIdAndDelete(req.params.id);
  if (!lot) return res.status(404).json({ error: 'not_found' });
  await Outbox.deleteMany({ lot: lot._id });
  res.json({ ok: true });
});

router.post('/bulk-delete', async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids_required' });
  }
  await Outbox.deleteMany({ lot: { $in: ids } });
  const r = await Lot.deleteMany({ _id: { $in: ids } });
  res.json({ ok: true, deleted: r.deletedCount || 0 });
});

router.post('/:id/clear-bounce', async (req, res) => {
  const lot = await Lot.findByIdAndUpdate(
    req.params.id,
    { $set: { bounceCount: 0, lastBounceAt: null, lastBounceError: '' } },
    { new: true }
  );
  if (!lot) return res.status(404).json({ error: 'not_found' });
  res.json(lot);
});

router.post('/:id/send', async (req, res) => {
  const { templateId } = req.body || {};
  if (!templateId) return res.status(400).json({ error: 'templateId_required' });
  const result = await enqueueBroadcast({ lotIds: [req.params.id], templateId });
  await bumpReminderCount(result.touchedLotIds);
  res.json(result);
});

// Place an outbound Aria call to this lot's buyer. The transcript, summary,
// duration, and outcome arrive later via /api/webhooks/elevenlabs; any booking
// Aria makes mid-call comes in through /api/aria/tools/book.
const CALL_ERROR_HTTP = {
  lot_not_found: [404, 'Lot not found.'],
  lot_opted_out: [409, 'This lot has opted out — calling is disabled.'],
  no_callable_buyer: [400, 'No buyer on this lot has a phone number to call.'],
  not_dispatchable: [
    503,
    'Aria calling isn’t configured. Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_AGENT_PHONE_NUMBER_ID.',
  ],
  buyer_missing_phone: [400, 'That buyer has no phone number.'],
  agent_not_configured: [503, 'Set ELEVENLABS_AGENT_ID before calling.'],
  agent_phone_number_not_configured: [503, 'Set ELEVENLABS_AGENT_PHONE_NUMBER_ID before calling.'],
};

router.post('/:id/call', async (req, res) => {
  const { buyerRole } = req.body || {};
  try {
    const result = await ariaCall.dispatchCall({ lotId: req.params.id, buyerRole });
    const lot = await Lot.findById(req.params.id).populate('project');
    res.json({ ...result, lot });
  } catch (err) {
    const mapped = CALL_ERROR_HTTP[err.code];
    if (mapped) return res.status(mapped[0]).json({ error: err.code, message: mapped[1] });
    // Upstream ElevenLabs failure (bad number, quota, etc.)
    const status = err.response?.status || 502;
    return res.status(status).json({
      error: 'call_dispatch_failed',
      message: err.response?.data?.detail || err.response?.data?.message || err.message,
    });
  }
});

// Stream the recording for this lot's most recent call. Proxied through the
// server because the ElevenLabs audio endpoint needs the API key — we never
// expose that to the browser.
router.get('/:id/recording', async (req, res) => {
  const lot = await Lot.findById(req.params.id).select('call').lean();
  if (!lot) return res.status(404).json({ error: 'not_found' });
  const cid = lot.call?.conversationId;
  if (!cid) return res.status(404).json({ error: 'no_recording' });
  try {
    const { stream, contentType, contentLength } = await elevenlabs.fetchConversationAudio(cid);
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'recording_stream_failed' });
      else res.destroy();
    });
  } catch (err) {
    const code = err.upstreamStatus === 404 ? 404 : 502;
    return res.status(code).json({
      error: err.code || 'recording_unavailable',
      message: err.upstreamStatus === 404 ? 'No recording is available for this call yet.' : err.message,
    });
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;

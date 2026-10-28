const express = require('express');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const LotEvent = require('../models/LotEvent');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast, bumpReminderCount } = require('../services/enqueue');
const { logStatusChange, logLotEvent } = require('../services/lotEventLogger');
const AlarmContract = require('../models/AlarmContract');
const ContractDocument = require('../models/ContractDocument');
const ContractEvent = require('../models/ContractEvent');
const ContractPayment = require('../models/ContractPayment');
const Setting = require('../models/Setting');
const { canReopenLot } = require('../services/contracts/status');
const { contractSummary, parseDateOnly } = require('../services/contracts/metrics');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const elevenlabs = require('../services/elevenlabs');
const ariaCall = require('../services/ariaCall');
const { GROUP_KEY_EXPR } = require('../services/sendGroups');

const router = express.Router();

router.get('/', async (req, res) => {
  const { project, projects, status, q, closed, limit = 200 } = req.query;
  const filter = {};
  if (projects) {
    const ids = String(projects).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 1) filter.project = ids[0];
    else if (ids.length > 1) filter.project = { $in: ids };
  } else if (project) {
    filter.project = project;
  }
  if (status) filter.status = status;
  // Home closing is its own flag, independent of the appointment `status`
  // (closed=1 → closed lots, closed=0 → not closed).
  if (closed === '1' || closed === 'true') filter['closing.closed'] = true;
  else if (closed === '0' || closed === 'false') filter['closing.closed'] = { $ne: true };
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

  // Attach per-lot count of queued SENDS (lot × channel, not per recipient) so
  // the board can surface "X queued" without a second round-trip.
  if (lots.length) {
    const lotIds = lots.map((l) => l._id);
    const counts = await Outbox.aggregate([
      { $match: { lot: { $in: lotIds }, status: { $in: ['pending', 'sending'] } } },
      { $group: { _id: { lot: '$lot', g: GROUP_KEY_EXPR } } },
      { $group: { _id: '$_id.lot', n: { $sum: 1 } } },
    ]);
    const map = new Map(counts.map((c) => [String(c._id), c.n]));
    for (const l of lots) l.pendingMessages = map.get(String(l._id)) || 0;

    // Per-lot communication breakdown (sends by MessageLog type) so the board
    // can show which channels have been used with small icons. A text to the
    // buyer and the co-buyer in one round counts once.
    const commsRows = await MessageLog.aggregate([
      { $match: { lot: { $in: lotIds } } },
      { $group: { _id: { lot: '$lot', type: '$type', g: GROUP_KEY_EXPR } } },
      { $group: { _id: { lot: '$_id.lot', type: '$_id.type' }, n: { $sum: 1 } } },
    ]);
    const commsMap = new Map();
    for (const r of commsRows) {
      const lid = String(r._id.lot);
      const entry = commsMap.get(lid) || {};
      entry[r._id.type] = r.n;
      commsMap.set(lid, entry);
    }
    for (const l of lots) l.comms = commsMap.get(String(l._id)) || {};

    // Current alarm monitoring contract per lot (number + status pill on the
    // board). `alarmContract` stays the id; the summary goes in `contract`.
    const contracts = await AlarmContract.find({ lot: { $in: lotIds }, isCurrent: true })
      .select('lot number status needsAttention package')
      .lean();
    const contractMap = new Map(contracts.map((c) => [String(c.lot), c]));
    for (const l of lots) {
      const c = contractMap.get(String(l._id));
      l.contract = c ? { _id: c._id, number: c.number, status: c.status, needsAttention: c.needsAttention || '', package: c.package || null } : null;
    }
  }

  res.json(lots);
});

router.get('/:id', async (req, res) => {
  const lot = await Lot.findById(req.params.id).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });
  const [history, queued, events, contract] = await Promise.all([
    MessageLog.find({ lot: lot._id }).sort({ createdAt: -1 }).limit(200).lean(),
    Outbox.find({ lot: lot._id, status: { $in: ['pending', 'sending'] } })
      .populate('templateId', 'name')
      .sort({ sendAfter: 1 })
      .lean(),
    LotEvent.find({ lot: lot._id }).sort({ createdAt: -1 }).limit(200).lean(),
    loadContractSummary(lot._id),
  ]);
  res.json({ lot, history, queued, events, contract });
});

// Summary of the lot's current alarm monitoring contract for the lot card:
// status, signers, package, next charge, document metadata, the last five
// contract events and which actions are allowed. null when there is none.
async function loadContractSummary(lotId) {
  const c = await AlarmContract.findOne({ lot: lotId, isCurrent: true }).lean();
  if (!c) return null;
  const [documents, events, setting, openPayment] = await Promise.all([
    ContractDocument.find({ contract: c._id }).select('-data').sort({ createdAt: -1 }).lean(),
    ContractEvent.find({ contract: c._id }).sort({ createdAt: -1 }).limit(5).lean(),
    Setting.getSingleton(),
    ContractPayment.findOne({ contract: c._id, status: 'open', attempted: true })
      .sort({ periodStart: -1, createdAt: -1 })
      .select('failureMessage nextPaymentAttempt')
      .lean(),
  ]);
  const alarm = (setting && setting.alarm) || {};
  return {
    ...contractSummary(c, { documents, events, openPayment }),
    globals: {
      paymentRemindersEnabled: alarm.paymentRemindersEnabled !== false,
      autoSendInvoices: alarm.autoSendInvoices !== false,
      defaultSigningMode: alarm.defaultSigningMode || 'remote',
    },
  };
}

router.post('/', async (req, res) => {
  const { project, lotNumber, address, model = '', buyers = [], status = 'pending', notes = '' } = req.body || {};
  if (!project || !lotNumber) return res.status(400).json({ error: 'project_and_lotNumber_required' });
  try {
    const lot = await Lot.create({ project, lotNumber, address, model, buyers, status, notes });
    res.status(201).json(lot);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'duplicate_lot_number' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  // `closing` is deliberately absent: it has its own route (below) with the
  // contract-in-progress guard.
  const allowed = ['lotNumber', 'address', 'model', 'buyers', 'status', 'notes', 'reminderCount'];
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

// Home closing. Deliberately separate from the appointment `status` (see the
// Lot model). Closing is a single reversible flag; it never creates a
// contract by itself. Reopening is refused while the lot's current
// monitoring contract is past draft (and not declined / voided), so a signed
// or billing contract can't be orphaned on an "open" lot.
router.post('/:id/closing', async (req, res) => {
  const { closed, closingDate } = req.body || {};
  if (typeof closed !== 'boolean') return res.status(400).json({ error: 'validation_failed', message: '`closed` must be true or false' });
  const before = await Lot.findById(req.params.id).select('project closing').lean();
  if (!before) return res.status(404).json({ error: 'not_found' });
  const wasClosed = Boolean(before.closing && before.closing.closed);

  let update;
  let message;
  if (closed) {
    let date = parseDateOnly(closingDate);
    if (date === undefined) return res.status(400).json({ error: 'validation_failed', message: 'Closing date is invalid', field: 'closingDate' });
    if (!date) {
      // Default: today in the schedule's zone (not UTC, so a late-evening
      // click doesn't record tomorrow).
      const tz = resolveScheduleTimezone(await Setting.getSingleton());
      date = parseDateOnly(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    }
    const prevDate = before.closing && before.closing.closingDate ? new Date(before.closing.closingDate).getTime() : null;
    if (wasClosed && prevDate === date.getTime()) {
      return res.json(await Lot.findById(req.params.id).populate('project'));
    }
    update = {
      'closing.closed': true,
      'closing.closingDate': date,
      ...(wasClosed ? {} : { 'closing.closedAt': new Date(), 'closing.closedBy': (req.user && req.user.username) || '' }),
    };
    message = wasClosed ? `Closing date changed to ${fmtDay(date)}` : `Lot marked closed (closing ${fmtDay(date)})`;
  } else {
    if (!wasClosed) return res.json(await Lot.findById(req.params.id).populate('project'));
    const current = await AlarmContract.findOne({ lot: before._id, isCurrent: true }).select('number status').lean();
    if (!canReopenLot(current && current.status)) {
      return res.status(409).json({
        error: 'contract_in_progress',
        message: `Contract ${current.number} is ${current.status.replace(/_/g, ' ')}; void or cancel it before reopening the lot.`,
      });
    }
    update = { 'closing.closed': false, 'closing.closingDate': null, 'closing.closedAt': null, 'closing.closedBy': '' };
    message = 'Lot reopened (closing cleared)';
  }

  const lot = await Lot.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).populate('project');
  if (!lot) return res.status(404).json({ error: 'not_found' });
  await logLotEvent({
    lot,
    project: before.project,
    type: 'closing',
    fromStatus: wasClosed ? 'closed' : 'open',
    toStatus: closed ? 'closed' : 'open',
    actor: 'user',
    message,
  });
  res.json(lot);
});

// "Nov 3, 2026" for a date-only value stored at 12:00 UTC.
function fmtDay(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

// Monitoring contracts are legal records tied to their lot, so a lot that has
// any (even a draft) can't be deleted until the draft is removed.
router.delete('/:id', async (req, res) => {
  const contract = await AlarmContract.findOne({ lot: req.params.id }).sort({ isCurrent: -1, createdAt: -1 }).select('number status').lean();
  if (contract) {
    return res.status(409).json({
      error: 'contract_in_progress',
      message:
        contract.status === 'draft'
          ? `This lot has draft monitoring contract ${contract.number}; delete the draft first.`
          : `This lot has monitoring contract ${contract.number} (${contract.status.replace(/_/g, ' ')}), which is kept as a record; the lot can't be deleted.`,
    });
  }
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
  // Lots with a monitoring contract are kept (see DELETE /:id).
  const withContracts = (await AlarmContract.distinct('lot', { lot: { $in: ids } })).map(String);
  const deletable = ids.filter((id) => !withContracts.includes(String(id)));
  await Outbox.deleteMany({ lot: { $in: deletable } });
  const r = await Lot.deleteMany({ _id: { $in: deletable } });
  // The ids lists let the board drop only what is really gone.
  res.json({
    ok: true,
    deleted: r.deletedCount || 0,
    deletedIds: deletable.map(String),
    skipped: withContracts.length,
    skippedIds: withContracts,
  });
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
  // A one-off send starts from now (inside the send window), not behind the
  // rest of the queue — the owner is pushing this one lot on purpose.
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
    // Upstream ElevenLabs failure (bad number, quota, an override the agent's
    // Security settings don't allow, etc.)
    const status = err.response?.status || (err.code === 'call_refused' ? 502 : 502);
    return res.status(status).json({
      error: err.code === 'call_refused' ? 'call_refused' : 'call_dispatch_failed',
      message: `ElevenLabs: ${elevenlabs.describeError(err)}`,
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

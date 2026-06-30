const express = require('express');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const { logStatusChange } = require('../services/lotEventLogger');

const router = express.Router();

router.get('/unmatched', async (req, res) => {
  const { status = 'unmatched', q, limit = 200 } = req.query;
  const filter = {};
  if (status !== 'all') filter.status = status;
  if (q) {
    const r = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ inviteeEmail: r }, { inviteeName: r }, { eventName: r }];
  }
  const rows = await CalendlyUnmatch.find(filter)
    .populate({ path: 'mappedLot', populate: { path: 'project', select: 'name' }, select: 'lotNumber' })
    .sort({ lastSeenAt: -1 })
    .limit(Math.min(Number(limit) || 200, 1000))
    .lean();
  res.json(rows);
});

// Bulk action on many queue entries at once (drives the "select all" UI).
// action: 'ignore' | 'unresolve' | 'delete'. Bulk mapping is intentionally
// omitted — each invitee maps to a different lot, so it can't be one-shot.
router.post('/unmatched/bulk', async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids_required' });
  }
  const filter = { _id: { $in: ids } };

  if (action === 'ignore') {
    const r = await CalendlyUnmatch.updateMany(filter, { $set: { status: 'ignored' } });
    return res.json({ ok: true, action, modified: r.modifiedCount || 0 });
  }
  if (action === 'unresolve') {
    const r = await CalendlyUnmatch.updateMany(filter, {
      $set: { status: 'unmatched', mappedLot: null, mappedAt: null },
    });
    return res.json({ ok: true, action, modified: r.modifiedCount || 0 });
  }
  if (action === 'delete') {
    const r = await CalendlyUnmatch.deleteMany(filter);
    return res.json({ ok: true, action, deleted: r.deletedCount || 0 });
  }
  return res.status(400).json({ error: 'invalid_action' });
});

router.post('/unmatched/:id/map', async (req, res) => {
  const { lotId, addAsBuyer = true } = req.body || {};
  if (!lotId) return res.status(400).json({ error: 'lotId_required' });

  const entry = await CalendlyUnmatch.findById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });

  const lot = await Lot.findById(lotId).populate('project', 'name');
  if (!lot) return res.status(404).json({ error: 'lot_not_found' });

  const emailLower = entry.inviteeEmail.toLowerCase();
  const alreadyBuyer = (lot.buyers || []).some((b) => (b.email || '').toLowerCase() === emailLower);

  // Optionally add the invitee as a buyer so future Calendly events auto-match
  if (addAsBuyer && !alreadyBuyer) {
    const usedRoles = new Set((lot.buyers || []).map((b) => b.role));
    const nextRole = ['buyer', 'coBuyer', 'thirdBuyer'].find((r) => !usedRoles.has(r));
    if (nextRole) {
      lot.buyers.push({
        role: nextRole,
        name: entry.inviteeName || '',
        email: entry.inviteeEmail,
        phone: '',
        optedOut: false,
      });
    }
  }

  const priorStatus = lot.status;
  if (lot.status !== 'scheduled') lot.status = 'scheduled';
  lot.calendlyEventUri = entry.eventUri || lot.calendlyEventUri;
  await lot.save();

  entry.status = 'mapped';
  entry.mappedLot = lot._id;
  entry.mappedAt = new Date();
  await entry.save();

  if (priorStatus !== 'scheduled') {
    await logStatusChange({
      lot,
      project: lot.project._id,
      fromStatus: priorStatus,
      toStatus: 'scheduled',
      actor: 'calendly_map',
      message: `Manually mapped ${entry.inviteeEmail} to ${entry.eventName || 'Calendly event'}.`,
    });
  }

  await MessageLog.create({
    project: lot.project._id,
    lot: lot._id,
    type: 'calendly',
    direction: 'in',
    to: entry.inviteeEmail,
    subject: entry.eventName || 'Calendly event (manual map)',
    body: `Manually mapped invitee ${entry.inviteeEmail} in event ${entry.eventUri} to lot ${lot.lotNumber}`,
    status: 'received',
    providerId: entry.eventUri,
    sentAt: new Date(),
  });

  res.json({ ok: true, entry, lot });
});

router.post('/unmatched/:id/ignore', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'ignored' } },
    { new: true }
  );
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json(entry);
});

router.post('/unmatched/:id/unresolve', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'unmatched', mappedLot: null, mappedAt: null } },
    { new: true }
  );
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json(entry);
});

router.delete('/unmatched/:id', async (req, res) => {
  const entry = await CalendlyUnmatch.findByIdAndDelete(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;

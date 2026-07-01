const express = require('express');
const MessageLog = require('../models/MessageLog');
const LotEvent = require('../models/LotEvent');

const router = express.Router();

const ACTOR_LABELS = {
  user: 'User',
  sender_worker: 'Sender',
  completion_worker: 'Auto-complete',
  calendly_sync: 'Calendly',
  calendly_map: 'Calendly mapping',
  aria_call: 'Aria',
  system: 'System',
};

// Unified activity feed: MessageLog (email / SMS / calendly / call) merged with
// LotEvent (status changes), newest first, paginated.
//
// Pagination across two collections without loading everything: the top
// page*pageSize of the merged set is guaranteed to be within the top
// page*pageSize of EACH source, so we fetch that many from each, merge, and
// slice. Fine at this scale; deep pages just fetch a bit more.
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 25));
  const { project, kind, q } = req.query;

  const msgFilter = {};
  const evFilter = {};
  if (project) {
    msgFilter.project = project;
    evFilter.project = project;
  }
  if (q) {
    const r = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    msgFilter.$or = [{ to: r }, { subject: r }, { body: r }, { error: r }];
    evFilter.message = r;
  }

  const wantMessages = !kind || kind === 'all' || kind === 'messages';
  const wantEvents = !kind || kind === 'all' || kind === 'events';
  const limitN = page * pageSize;

  const [msgs, events, msgCount, evCount] = await Promise.all([
    wantMessages
      ? MessageLog.find(msgFilter)
          .populate('project', 'name')
          .populate('lot', 'lotNumber')
          .sort({ createdAt: -1 })
          .limit(limitN)
          .lean()
      : [],
    wantEvents
      ? LotEvent.find(evFilter)
          .populate('project', 'name')
          .populate('lot', 'lotNumber')
          .sort({ createdAt: -1 })
          .limit(limitN)
          .lean()
      : [],
    wantMessages ? MessageLog.countDocuments(msgFilter) : 0,
    wantEvents ? LotEvent.countDocuments(evFilter) : 0,
  ]);

  const normMsg = (m) => ({
    _id: `m-${m._id}`,
    kind: 'message',
    createdAt: m.createdAt,
    type: m.type,
    direction: m.direction,
    project: m.project,
    lot: m.lot,
    to: m.to,
    subject: m.subject,
    body: m.body,
    status: m.status,
    error: m.error,
  });
  const normEv = (e) => ({
    _id: `e-${e._id}`,
    kind: 'event',
    createdAt: e.createdAt,
    type: 'status_change',
    project: e.project,
    lot: e.lot,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    actor: e.actor,
    actorLabel: ACTOR_LABELS[e.actor] || e.actor,
    message: e.message,
  });

  const merged = [...msgs.map(normMsg), ...events.map(normEv)].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const total = msgCount + evCount;
  const start = (page - 1) * pageSize;
  const items = merged.slice(start, start + pageSize);

  res.json({ items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
});

module.exports = router;

const express = require('express');
const Lot = require('../models/Lot');
const Project = require('../models/Project');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Setting = require('../models/Setting');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');
const CallQueueItem = require('../models/CallQueueItem');
const env = require('../config/env');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const { scheduleStatus } = require('../services/outboxPlanner');
const { GROUP_KEY_EXPR } = require('../services/sendGroups');
const contractMetrics = require('../services/contracts/metrics');

const router = express.Router();

// Sends (lot × channel × round) by type and direction since `since` — a text
// to the buyer and co-buyer in one round counts once.
const sendsSince = (since) =>
  MessageLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { type: '$type', direction: '$direction', g: GROUP_KEY_EXPR } } },
    { $group: { _id: { type: '$_id.type', direction: '$_id.direction' }, n: { $sum: 1 } } },
  ]);

router.get('/', async (req, res) => {
  const now = new Date();
  const since = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const [
    lotStatusCounts,
    outboxCounts,
    messages24h,
    messages7d,
    messages30d,
    recent,
    warnings,
    perProject,
    setting,
    unmatchedCalendly,
    unmatchedCalendlyList,
    bouncedLots,
    recentFailures,
    nextSend,
    callCounts,
    alarm,
  ] = await Promise.all([
    Lot.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Outbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    sendsSince(since(1)),
    sendsSince(since(7)),
    sendsSince(since(30)),
    MessageLog.find({})
      .sort({ createdAt: -1 })
      .limit(25)
      .populate('project', 'name')
      .populate('lot', 'lotNumber')
      .lean(),
    // Only live warnings: a lot that is done (completed / opted out) or whose
    // appointment has already passed has nothing left to double-book.
    Lot.find({
      calendlyWarning: { $ne: '' },
      status: { $nin: ['completed', 'opted_out'] },
      $nor: [
        { 'calendlyEvent.endTime': { $ne: null, $lte: now } },
        { 'calendlyEvent.endTime': null, 'calendlyEvent.startTime': { $ne: null, $lte: now } },
      ],
    })
      .populate('project', 'name')
      .select('lotNumber address calendlyWarning project status calendlyEvent.startTime calendlyEvent.endTime calendlyEvent.name')
      .sort({ 'calendlyEvent.startTime': 1 })
      .limit(50)
      .lean(),
    Project.aggregate([
      {
        $lookup: {
          from: 'lots',
          localField: '_id',
          foreignField: 'project',
          as: 'lots',
        },
      },
      {
        $project: {
          name: 1,
          reminderIntervalDays: 1,
          maxReminders: 1,
          totalLots: { $size: '$lots' },
          byStatus: {
            pending: {
              $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'pending'] } } },
            },
            contacted: {
              $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'contacted'] } } },
            },
            scheduled: {
              $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'scheduled'] } } },
            },
            completed: {
              $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'completed'] } } },
            },
            opted_out: {
              $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'opted_out'] } } },
            },
          },
        },
      },
      { $sort: { name: 1 } },
    ]),
    Setting.getSingleton(),
    CalendlyUnmatch.countDocuments({ status: 'unmatched' }),
    CalendlyUnmatch.find({ status: 'unmatched' })
      .sort({ lastSeenAt: -1 })
      .limit(10)
      .lean(),
    Lot.find({ bounceCount: { $gt: 0 } })
      .populate('project', 'name')
      .select('lotNumber bounceCount lastBounceAt lastBounceError project status buyers')
      .sort({ lastBounceAt: -1 })
      .limit(20)
      .lean(),
    MessageLog.find({ status: 'failed', direction: 'out' })
      .sort({ createdAt: -1 })
      .limit(15)
      .populate('project', 'name')
      .populate('lot', 'lotNumber address')
      .lean(),
    Outbox.findOne({ status: 'pending' }).sort({ sendAfter: 1 }).select('sendAfter type').lean(),
    CallQueueItem.aggregate([
      { $match: { status: { $in: ['queued', 'calling'] } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    // Monitoring tiles. A failure here must not take the whole dashboard down.
    contractMetrics.dashboardBlock().catch((err) => {
      console.warn('[dashboard] alarm block failed', err.message);
      return null;
    }),
  ]);

  const shape = (rows) => {
    const out = { email: { out: 0, in: 0 }, sms: { out: 0, in: 0 }, calendly: { out: 0, in: 0 } };
    for (const r of rows) {
      const t = r._id.type || 'email';
      const d = r._id.direction || 'out';
      if (!out[t]) out[t] = { out: 0, in: 0 };
      out[t][d] = r.n;
    }
    return out;
  };

  const lotByStatus = {};
  for (const r of lotStatusCounts) lotByStatus[r._id] = r.n;
  const outboxByStatus = {};
  for (const r of outboxCounts) outboxByStatus[r._id] = r.n;

  const callsByStatus = {};
  for (const r of callCounts) callsByStatus[r._id] = r.n;

  res.json({
    lotsByStatus: lotByStatus,
    outboxByStatus,
    timezone: resolveScheduleTimezone(setting),
    schedule: await scheduleStatus(setting),
    nextSendAt: nextSend ? nextSend.sendAfter : null,
    callQueue: { calling: callsByStatus.calling || 0, queued: callsByStatus.queued || 0 },
    messages: {
      last24h: shape(messages24h),
      last7d: shape(messages7d),
      last30d: shape(messages30d),
    },
    recent,
    warnings,
    perProject,
    unmatchedCalendly: { count: unmatchedCalendly, recent: unmatchedCalendlyList },
    bouncedLots,
    recentFailures,
    alarm,
    health: {
      smtp: setting.smtpHealth,
      twilio: setting.twilioHealth,
      calendly: setting.calendlyHealth,
      lastCalendlySync: setting.lastCalendlySync,
      senderPaused: setting.senderPaused,
      remindersPaused: !!setting.remindersPaused,
      aria: {
        ok: env.elevenlabs.dispatchable,
        message: env.elevenlabs.dispatchable
          ? 'ready to call'
          : env.elevenlabs.configured
            ? 'agent id / phone id missing in .env'
            : 'ELEVENLABS_API_KEY not set',
      },
      // Same shape as smtp/twilio ({ok, checkedAt, message}) plus whether the
      // integration is set up at all; the last Settings → Test result.
      stripe: {
        configured: env.stripe.configured,
        mode: env.stripe.mode,
        ...healthOf(setting.stripeHealth, env.stripe.configured, 'STRIPE_SECRET_KEY not set'),
      },
      docusign: {
        configured: env.docusign.configured,
        ...healthOf(setting.docusignHealth, env.docusign.configured, 'DocuSign keys not set in .env'),
      },
    },
  });
});

// {ok, checkedAt, message} from a stored health check, or "not configured".
function healthOf(h, configured, notConfiguredMessage) {
  if (!configured) return { ok: false, checkedAt: null, message: notConfiguredMessage };
  const x = (h && h.toObject ? h.toObject() : h) || {};
  return { ok: Boolean(x.ok), checkedAt: x.checkedAt || null, message: x.message || (x.checkedAt ? '' : 'not tested yet') };
}

module.exports = router;

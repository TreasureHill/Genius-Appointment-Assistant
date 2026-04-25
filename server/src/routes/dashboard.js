const express = require('express');
const Lot = require('../models/Lot');
const Project = require('../models/Project');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const Setting = require('../models/Setting');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');

const router = express.Router();

router.get('/', async (req, res) => {
  const since = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
  ] = await Promise.all([
    Lot.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Outbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    MessageLog.aggregate([
      { $match: { createdAt: { $gte: since(1) } } },
      { $group: { _id: { type: '$type', direction: '$direction' }, n: { $sum: 1 } } },
    ]),
    MessageLog.aggregate([
      { $match: { createdAt: { $gte: since(7) } } },
      { $group: { _id: { type: '$type', direction: '$direction' }, n: { $sum: 1 } } },
    ]),
    MessageLog.aggregate([
      { $match: { createdAt: { $gte: since(30) } } },
      { $group: { _id: { type: '$type', direction: '$direction' }, n: { $sum: 1 } } },
    ]),
    MessageLog.find({})
      .sort({ createdAt: -1 })
      .limit(25)
      .populate('project', 'name')
      .populate('lot', 'lotNumber')
      .lean(),
    Lot.find({ calendlyWarning: { $ne: '' } })
      .populate('project', 'name')
      .select('lotNumber calendlyWarning project status')
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

  res.json({
    lotsByStatus: lotByStatus,
    outboxByStatus,
    messages: {
      last24h: shape(messages24h),
      last7d: shape(messages7d),
      last30d: shape(messages30d),
    },
    recent,
    warnings,
    perProject,
    unmatchedCalendly: { count: unmatchedCalendly, recent: unmatchedCalendlyList },
    health: {
      smtp: setting.smtpHealth,
      twilio: setting.twilioHealth,
      calendly: setting.calendlyHealth,
      lastCalendlySync: setting.lastCalendlySync,
      senderPaused: setting.senderPaused,
    },
  });
});

module.exports = router;

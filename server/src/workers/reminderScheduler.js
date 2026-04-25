const cron = require('node-cron');
const Project = require('../models/Project');
const Lot = require('../models/Lot');
const Template = require('../models/Template');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast } = require('../services/enqueue');

// Hourly: find lots that are due for a reminder, enqueue default email + sms.
async function runOnce() {
  const now = new Date();
  const projects = await Project.find({ active: true }).lean();
  if (!projects.length) return { scanned: 0, enqueued: 0 };

  const defaultEmail = await Template.findOne({ type: 'email', isDefaultReminder: true }).lean();
  const defaultSms = await Template.findOne({ type: 'sms', isDefaultReminder: true }).lean();
  if (!defaultEmail && !defaultSms) return { scanned: 0, enqueued: 0, reason: 'no_default_templates' };

  let totalEnqueued = 0;
  let totalScanned = 0;

  for (const project of projects) {
    const cutoff = new Date(now.getTime() - (project.reminderIntervalDays || 14) * 24 * 60 * 60 * 1000);
    // Only contacted lots get automatic reminders. 'pending' means the user
    // has never manually triggered a send for this lot, so we do nothing —
    // first contact must always be a manual action from the Board.
    const due = await Lot.find({
      project: project._id,
      status: 'contacted',
      reminderCount: { $lt: project.maxReminders || 3 },
      lastContactedAt: { $ne: null, $lte: cutoff },
    })
      .select('_id')
      .lean();
    totalScanned += due.length;
    if (!due.length) continue;

    const lotIds = due.map((l) => l._id);

    // Skip lots that already have a pending reminder in the outbox
    const alreadyQueued = await Outbox.distinct('lot', {
      lot: { $in: lotIds },
      status: 'pending',
      isReminder: true,
    });
    const queuedSet = new Set(alreadyQueued.map((x) => String(x)));
    const filtered = lotIds.filter((id) => !queuedSet.has(String(id)));
    if (!filtered.length) continue;

    if (defaultEmail) {
      const r = await enqueueBroadcast({
        lotIds: filtered,
        templateId: defaultEmail._id,
        isReminder: true,
      });
      totalEnqueued += r.queued.length;
    }
    if (defaultSms) {
      const r = await enqueueBroadcast({
        lotIds: filtered,
        templateId: defaultSms._id,
        isReminder: true,
      });
      totalEnqueued += r.queued.length;
    }
  }

  if (totalEnqueued) console.log(`[reminders] scanned ${totalScanned} lots, enqueued ${totalEnqueued} messages`);
  return { scanned: totalScanned, enqueued: totalEnqueued };
}

function start() {
  // Top of every hour
  cron.schedule('0 * * * *', () => {
    runOnce().catch((e) => console.error('[reminders]', e));
  });
  console.log('[reminders] scheduler started (hourly)');
}

module.exports = { start, runOnce };

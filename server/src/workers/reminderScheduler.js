const cron = require('node-cron');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const Template = require('../models/Template');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast, bumpReminderCount } = require('../services/enqueue');

// Hourly: find lots that have been manually contacted at least once and are
// past their next-reminder due date. Pacing, interval, and max are all read
// from the global Setting singleton (single-owner system).
async function runOnce() {
  const setting = await Setting.getSingleton();
  if (setting.remindersPaused) return { scanned: 0, enqueued: 0, reason: 'reminders_paused' };
  const sched = setting.schedule || {};
  const intervalDays = sched.reminderIntervalDays ?? 14;
  const maxReminders = sched.maxReminders ?? 3;

  const cutoff = new Date(Date.now() - intervalDays * 24 * 60 * 60 * 1000);

  // Pick up the project's default templates if set on the singleton; otherwise
  // fall back to whichever template is flagged isDefaultReminder.
  let emailTpl = null;
  let smsTpl = null;
  if (sched.defaultEmailTemplate) emailTpl = await Template.findById(sched.defaultEmailTemplate).lean();
  if (sched.defaultSmsTemplate) smsTpl = await Template.findById(sched.defaultSmsTemplate).lean();
  if (!emailTpl) emailTpl = await Template.findOne({ type: 'email', isDefaultReminder: true }).lean();
  if (!smsTpl) smsTpl = await Template.findOne({ type: 'sms', isDefaultReminder: true }).lean();
  if (!emailTpl && !smsTpl) return { scanned: 0, enqueued: 0, reason: 'no_default_templates' };

  // Only contacted lots get automatic reminders. 'pending' = never manually
  // contacted, the user must pick + send from the Board first.
  const due = await Lot.find({
    status: 'contacted',
    reminderCount: { $lt: maxReminders },
    lastContactedAt: { $ne: null, $lte: cutoff },
  })
    .select('_id')
    .lean();
  if (!due.length) return { scanned: 0, enqueued: 0 };

  const lotIds = due.map((l) => l._id);
  // Skip lots that already have a pending reminder queued
  const alreadyQueued = await Outbox.distinct('lot', {
    lot: { $in: lotIds },
    status: 'pending',
    isReminder: true,
  });
  const queuedSet = new Set(alreadyQueued.map((x) => String(x)));
  const filtered = lotIds.filter((id) => !queuedSet.has(String(id)));
  if (!filtered.length) return { scanned: due.length, enqueued: 0 };

  let totalEnqueued = 0;
  const touched = new Set();
  if (emailTpl) {
    const r = await enqueueBroadcast({ lotIds: filtered, templateId: emailTpl._id, isReminder: true });
    totalEnqueued += r.queued.length;
    for (const id of r.touchedLotIds) touched.add(id);
  }
  if (smsTpl) {
    const r = await enqueueBroadcast({ lotIds: filtered, templateId: smsTpl._id, isReminder: true });
    totalEnqueued += r.queued.length;
    for (const id of r.touchedLotIds) touched.add(id);
  }
  await bumpReminderCount(Array.from(touched));
  if (totalEnqueued) {
    console.log(`[reminders] scanned ${due.length} due lots, enqueued ${totalEnqueued} messages across ${touched.size} lots`);
  }
  return { scanned: due.length, enqueued: totalEnqueued };
}

function start() {
  cron.schedule('0 * * * *', () => {
    runOnce().catch((e) => console.error('[reminders]', e));
  });
  console.log('[reminders] scheduler started (hourly, uses Settings → Schedule)');
}

module.exports = { start, runOnce };

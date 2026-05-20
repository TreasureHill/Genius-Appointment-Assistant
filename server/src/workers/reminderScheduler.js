const cron = require('node-cron');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const Outbox = require('../models/Outbox');
const { enqueueBroadcast, bumpReminderCount } = require('../services/enqueue');
const { resolveDefaultsForProject } = require('../services/templateResolver');

// Hourly: find lots that have been manually contacted at least once and are
// past their next-reminder due date. Pacing, interval, and max are read from
// the global Setting singleton. Default templates are resolved per project
// (project-level override → Setting singleton → isDefaultReminder fallback).
async function runOnce() {
  const setting = await Setting.getSingleton();
  if (setting.remindersPaused) return { scanned: 0, enqueued: 0, reason: 'reminders_paused' };
  const sched = setting.schedule || {};
  const intervalDays = sched.reminderIntervalDays ?? 14;
  const maxReminders = sched.maxReminders ?? 3;

  const cutoff = new Date(Date.now() - intervalDays * 24 * 60 * 60 * 1000);

  // Only contacted lots get automatic reminders. 'pending' = never manually
  // contacted, the user must pick + send from the Board first.
  const due = await Lot.find({
    status: 'contacted',
    reminderCount: { $lt: maxReminders },
    lastContactedAt: { $ne: null, $lte: cutoff },
  })
    .select('_id project')
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
  const filtered = due.filter((l) => !queuedSet.has(String(l._id)));
  if (!filtered.length) return { scanned: due.length, enqueued: 0 };

  // Group lots by project so each project resolves its own default templates.
  const byProject = new Map();
  for (const l of filtered) {
    const pid = String(l.project);
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(l._id);
  }

  let totalEnqueued = 0;
  const touched = new Set();
  let anyTemplateFound = false;

  for (const [pid, ids] of byProject) {
    const { emailTpl, smsTpl } = await resolveDefaultsForProject(pid);
    if (!emailTpl && !smsTpl) continue;
    anyTemplateFound = true;
    if (emailTpl) {
      const r = await enqueueBroadcast({ lotIds: ids, templateId: emailTpl._id, isReminder: true });
      totalEnqueued += r.queued.length;
      for (const id of r.touchedLotIds) touched.add(id);
    }
    if (smsTpl) {
      const r = await enqueueBroadcast({ lotIds: ids, templateId: smsTpl._id, isReminder: true });
      totalEnqueued += r.queued.length;
      for (const id of r.touchedLotIds) touched.add(id);
    }
  }

  if (!anyTemplateFound) return { scanned: due.length, enqueued: 0, reason: 'no_default_templates' };

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

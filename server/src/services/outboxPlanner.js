const Outbox = require('../models/Outbox');
const Setting = require('../models/Setting');
const { nextSendOpening, resolveScheduleTimezone, windowStatus } = require('./sendWindow');
const { randomBetween } = require('./enqueue');

// Re-plan every pending message from `from` (default: now): same order, fresh
// pacing, every slot inside the current send windows and timezone. Rows the
// owner forced with "Send now" are left alone. Runs after the schedule is
// saved (so a window moved from 9 AM to 10 AM moves the queue with it), on
// demand from the Queue page, and once at boot when the timezone setting is
// first introduced.
async function replanPendingOutbox({ from = new Date() } = {}) {
  const setting = await Setting.getSingleton();
  const sched = setting.schedule || {};
  const timezone = resolveScheduleTimezone(setting);
  const pacing = sched.pacing || { minSec: 30, maxSec: 120 };

  const rows = await Outbox.find({ status: 'pending', sendNow: { $ne: true } })
    .sort({ sendAfter: 1, createdAt: 1, _id: 1 })
    .select('_id sendAfter')
    .lean();

  const ops = [];
  let cursor = new Date(Math.max(new Date(from).getTime() || 0, Date.now()));
  let moved = 0;
  let firstSendAt = null;
  let lastSendAt = null;
  for (const row of rows) {
    const slot = nextSendOpening(sched.sendWindows, cursor, timezone) || cursor;
    if (Math.abs(slot.getTime() - new Date(row.sendAfter).getTime()) > 1000) {
      ops.push({
        updateOne: { filter: { _id: row._id, status: 'pending' }, update: { $set: { sendAfter: slot } } },
      });
      moved += 1;
    }
    if (!firstSendAt) firstSendAt = slot;
    lastSendAt = slot;
    cursor = new Date(slot.getTime() + randomBetween(pacing.minSec, pacing.maxSec) * 1000);
  }
  if (ops.length) await Outbox.bulkWrite(ops, { ordered: false });
  return { total: rows.length, moved, timezone, firstSendAt, lastSendAt };
}

// Window + pause state in one call — what the Queue page, Settings and the
// lot page render as "Open until 9:00 PM" / "Closed, opens Fri 9:00 AM".
async function scheduleStatus(setting) {
  const s = setting || (await Setting.getSingleton());
  const sched = s.schedule || {};
  const timezone = resolveScheduleTimezone(s);
  return {
    ...windowStatus(sched.sendWindows, new Date(), timezone),
    senderPaused: !!s.senderPaused,
    remindersPaused: !!s.remindersPaused,
    pacing: {
      minSec: sched.pacing?.minSec ?? 30,
      maxSec: sched.pacing?.maxSec ?? 120,
    },
  };
}

module.exports = { replanPendingOutbox, scheduleStatus };

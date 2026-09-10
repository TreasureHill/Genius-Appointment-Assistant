const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const Template = require('../models/Template');
const Setting = require('../models/Setting');
const { renderTemplate, renderContext } = require('./templateRender');
const { nextSendOpening, resolveScheduleTimezone } = require('./sendWindow');

function randomBetween(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

// Where a new batch should start: the last planned send in the pending queue
// plus one pacing gap. New batches pace on from here, so two "Send to all
// pending" clicks (or a manual batch plus the hourly reminders) never blast
// in parallel — pacing is one global line. Rows the owner forced with "Send
// now" don't count. Null when the queue is empty (start from now).
async function queueTail() {
  const last = await Outbox.findOne({ status: 'pending', sendNow: { $ne: true } })
    .sort({ sendAfter: -1 })
    .select('sendAfter')
    .lean();
  if (!last) return null;
  const setting = await Setting.getSingleton();
  const pacing = setting.schedule?.pacing || { minSec: 30, maxSec: 120 };
  return new Date(new Date(last.sendAfter).getTime() + randomBetween(pacing.minSec, pacing.maxSec) * 1000);
}

// A send slot that is never before `from` and always inside an enabled send
// window (evaluated in the schedule's timezone). When every day is disabled
// there is no opening; keep `from` and let the worker hold the row until a
// day is switched back on.
function planSlot(sendWindows, from, tz) {
  return nextSendOpening(sendWindows, from, tz) || from;
}

// Enqueue a template (email or sms) for selected lots. Pacing, reminder caps,
// send windows and the timezone all live on the global Setting singleton.
//
// Every row gets its real send time here — inside the send window, spaced by
// the pacing jitter — so the Queue page shows exactly when each message goes
// out the moment it's queued (the worker only re-checks at send time).
//
// `startAt` lets callers chain batches: pass the previous call's `nextCursor`
// (or `queueTail()`) so email + SMS, or several projects, pace as one line.
//
// Note: this function does NOT increment lot.reminderCount. The caller is
// responsible for bumping the count exactly once per "send round" via
// bumpReminderCount() — that way a round that fans out across multiple
// templates (e.g. Send to all pending fires email + SMS) only counts as
// ONE reminder, not one per channel.
async function enqueueBroadcast({ lotIds, templateId, isReminder = false, startAt = null }) {
  const template = await Template.findById(templateId);
  if (!template) throw new Error('Template not found');

  const lots = await Lot.find({ _id: { $in: lotIds } }).populate('project');

  const setting = await Setting.getSingleton();
  const owner = setting.owner || {};
  const sched = setting.schedule || {};
  const pacing = sched.pacing || { minSec: 30, maxSec: 120 };
  const maxReminders = sched.maxReminders ?? 3;
  const timezone = resolveScheduleTimezone(setting);
  const sendWindows = sched.sendWindows;

  const queued = [];
  const skipped = [];
  const touchedLotIds = new Set();

  // Never plan into the past: a stale startAt (a queue tail that already went
  // out) simply starts from now.
  const now = Date.now();
  let cursor = new Date(startAt ? Math.max(new Date(startAt).getTime() || 0, now) : now);
  let firstSendAt = null;
  let lastSendAt = null;

  for (const lot of lots) {
    if (Lot.STOP_STATUSES.includes(lot.status)) {
      skipped.push({ lotId: String(lot._id), reason: `status=${lot.status}` });
      continue;
    }
    if (lot.reminderCount >= maxReminders) {
      skipped.push({
        lotId: String(lot._id),
        reason: `max reminders reached (${lot.reminderCount}/${maxReminders})`,
      });
      continue;
    }
    let queuedThisLot = 0;
    const sentTo = new Set();
    for (let i = 0; i < lot.buyers.length; i++) {
      const buyer = lot.buyers[i];
      if (buyer.optedOut) {
        skipped.push({ lotId: String(lot._id), reason: `buyer ${buyer.role} opted out` });
        continue;
      }
      const to = template.type === 'email' ? buyer.email : buyer.phone;
      if (!to) {
        skipped.push({ lotId: String(lot._id), reason: `buyer ${buyer.role} missing ${template.type}` });
        continue;
      }
      const dedupKey = String(to).toLowerCase().trim();
      if (sentTo.has(dedupKey)) {
        skipped.push({
          lotId: String(lot._id),
          reason: `buyer ${buyer.role} duplicate ${template.type} (${to}) within lot`,
        });
        continue;
      }
      sentTo.add(dedupKey);
      const ctx = renderContext({ project: lot.project, lot, buyer, owner });
      const rendered = renderTemplate(template, ctx);

      const sendAfter = planSlot(sendWindows, cursor, timezone);
      await Outbox.create({
        project: lot.project._id,
        lot: lot._id,
        buyerIndex: i,
        type: template.type,
        templateId: template._id,
        to,
        renderedSubject: rendered.subject,
        renderedBody: template.type === 'email' ? rendered.html : rendered.text || rendered.html,
        renderedText: rendered.text,
        sendAfter,
        status: 'pending',
        isReminder,
        reminderIndex: isReminder ? lot.reminderCount + 1 : 0,
      });
      queued.push({ lotId: String(lot._id), buyerIndex: i, type: template.type, to, sendAfter });
      queuedThisLot += 1;
      if (!firstSendAt) firstSendAt = sendAfter;
      lastSendAt = sendAfter;

      const jitter = randomBetween(pacing.minSec, pacing.maxSec);
      cursor = new Date(sendAfter.getTime() + jitter * 1000);
    }
    if (queuedThisLot > 0) {
      touchedLotIds.add(String(lot._id));
    }
  }
  return {
    queued,
    skipped,
    touchedLotIds: Array.from(touchedLotIds),
    firstSendAt,
    lastSendAt,
    // Where the next batch should start so it paces on after this one.
    nextCursor: cursor,
    timezone,
  };
}

// Bump lot.reminderCount by 1 for each lot in the list. Idempotency is the
// caller's responsibility — typically you union touchedLotIds across every
// enqueueBroadcast call in a single user action and pass the deduped list
// here once.
async function bumpReminderCount(lotIds) {
  if (!Array.isArray(lotIds) || lotIds.length === 0) return { matched: 0 };
  const r = await Lot.updateMany({ _id: { $in: lotIds } }, { $inc: { reminderCount: 1 } });
  return { matched: r.modifiedCount || r.nModified || 0 };
}

module.exports = { enqueueBroadcast, bumpReminderCount, randomBetween, queueTail, planSlot };

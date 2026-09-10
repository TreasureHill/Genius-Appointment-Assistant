const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const Template = require('../models/Template');
const Setting = require('../models/Setting');
const { renderTemplate, renderContext, combinedRecipientView } = require('./templateRender');
const { nextSendOpening, resolveScheduleTimezone } = require('./sendWindow');
const { newSendGroup } = require('./sendGroups');

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

// Who on this lot gets this channel: not opted out, has an address, and each
// address only once per lot. Skips are reported so the UI can explain them.
function eligibleRecipients(lot, type, skipped) {
  const out = [];
  const seen = new Set();
  const buyers = lot.buyers || [];
  for (let i = 0; i < buyers.length; i++) {
    const buyer = buyers[i];
    if (buyer.optedOut) {
      skipped.push({ lotId: String(lot._id), reason: `buyer ${buyer.role} opted out` });
      continue;
    }
    const address = type === 'email' ? buyer.email : buyer.phone;
    if (!address) {
      skipped.push({ lotId: String(lot._id), reason: `buyer ${buyer.role} missing ${type}` });
      continue;
    }
    const key = type === 'email' ? String(address).toLowerCase().trim() : String(address).replace(/\D/g, '');
    if (seen.has(key)) {
      skipped.push({ lotId: String(lot._id), reason: `buyer ${buyer.role} duplicate ${type} (${address}) within lot` });
      continue;
    }
    seen.add(key);
    out.push({ buyerIndex: i, role: buyer.role, name: buyer.name || '', address: String(address).trim(), buyer });
  }
  return out;
}

const strip = ({ buyerIndex, role, name, address }) => ({ buyerIndex, role, name, address });

// Enqueue a template (email or sms) for selected lots. Pacing, reminder caps,
// send windows, the timezone and the per-lot email preference all live on
// the global Setting singleton.
//
// The LOT is the unit of sending: one send per lot per channel, one pacing
// slot, one send group. An email goes out once, addressed to every buyer on
// the lot (unless Settings → "one email per buyer"), rendered with the
// buyers' names joined ("Hi Jane and John,"). Texts can't be combined, so one
// row per phone goes out in the same slot under the same group.
//
// Every row gets its real send time here — inside the send window, spaced by
// the pacing jitter — so the Queue page shows exactly when each send goes
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
  const emailPerLot = sched.emailPerLot !== false;
  const timezone = resolveScheduleTimezone(setting);
  const sendWindows = sched.sendWindows;

  const queued = [];
  const sends = [];
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
    const recipients = eligibleRecipients(lot, template.type, skipped);
    if (!recipients.length) continue;

    // One slot and one group for the whole lot.
    const sendAfter = planSlot(sendWindows, cursor, timezone);
    const sendGroup = newSendGroup();
    const rows = [];
    if (template.type === 'email' && emailPerLot) {
      // ONE email, addressed to every buyer on the lot.
      const view = combinedRecipientView(recipients.map((r) => r.buyer));
      const rendered = renderTemplate(template, renderContext({ project: lot.project, lot, buyer: view, owner }));
      rows.push({
        buyerIndex: recipients[0].buyerIndex,
        to: recipients.map((r) => r.address).join(', '),
        recipients: recipients.map(strip),
        rendered,
      });
    } else {
      // One text per phone (or one email per buyer when the owner prefers
      // that) — personalised each, same slot, same group.
      for (const r of recipients) {
        const rendered = renderTemplate(template, renderContext({ project: lot.project, lot, buyer: r.buyer, owner }));
        rows.push({ buyerIndex: r.buyerIndex, to: r.address, recipients: [strip(r)], rendered });
      }
    }

    for (const row of rows) {
      await Outbox.create({
        project: lot.project._id,
        lot: lot._id,
        buyerIndex: row.buyerIndex,
        type: template.type,
        templateId: template._id,
        to: row.to,
        renderedSubject: row.rendered.subject,
        renderedBody: template.type === 'email' ? row.rendered.html : row.rendered.text || row.rendered.html,
        renderedText: row.rendered.text,
        sendAfter,
        status: 'pending',
        isReminder,
        reminderIndex: isReminder ? lot.reminderCount + 1 : 0,
        sendGroup,
        recipients: row.recipients,
      });
      queued.push({ lotId: String(lot._id), buyerIndex: row.buyerIndex, type: template.type, to: row.to, sendAfter, sendGroup });
    }
    sends.push({
      lotId: String(lot._id),
      type: template.type,
      sendGroup,
      recipients: recipients.map(strip),
      sendAfter,
    });
    touchedLotIds.add(String(lot._id));
    if (!firstSendAt) firstSendAt = sendAfter;
    lastSendAt = sendAfter;

    const jitter = randomBetween(pacing.minSec, pacing.maxSec);
    cursor = new Date(sendAfter.getTime() + jitter * 1000);
  }
  return {
    // One entry per row written (per recipient for texts / per-buyer emails).
    queued,
    // One entry per lot × channel — what the UI counts and shows.
    sends,
    sendCount: sends.length,
    skipped,
    touchedLotIds: Array.from(touchedLotIds),
    firstSendAt,
    lastSendAt,
    // Where the next batch should start so it paces on after this one.
    nextCursor: cursor,
    timezone,
    emailPerLot,
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

module.exports = { enqueueBroadcast, bumpReminderCount, randomBetween, queueTail, planSlot, eligibleRecipients };

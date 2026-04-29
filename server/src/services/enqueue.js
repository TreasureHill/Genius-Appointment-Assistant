const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const Template = require('../models/Template');
const Setting = require('../models/Setting');
const { renderTemplate, renderContext } = require('./templateRender');

function randomBetween(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

// Enqueue a template (email or sms) for selected lots. Pacing and reminder
// caps live on the global Setting singleton (single-owner system).
async function enqueueBroadcast({ lotIds, templateId, isReminder = false, startAt = null }) {
  const template = await Template.findById(templateId);
  if (!template) throw new Error('Template not found');

  const lots = await Lot.find({ _id: { $in: lotIds } }).populate('project');

  const setting = await Setting.getSingleton();
  const owner = setting.owner || {};
  const sched = setting.schedule || {};
  const pacing = sched.pacing || { minSec: 30, maxSec: 120 };
  const maxReminders = sched.maxReminders ?? 3;

  const queued = [];
  const skipped = [];

  let cursor = startAt ? new Date(startAt) : new Date();

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
        sendAfter: cursor,
        status: 'pending',
        isReminder,
        reminderIndex: isReminder ? lot.reminderCount + 1 : 0,
      });
      queued.push({ lotId: String(lot._id), buyerIndex: i, sendAfter: cursor });
      queuedThisLot += 1;

      const jitter = randomBetween(pacing.minSec, pacing.maxSec);
      cursor = new Date(cursor.getTime() + jitter * 1000);
    }
    // Reminder count is per-lot, not per-recipient: bump it once per
    // enqueue-round if anything actually got queued. Multiple buyers in the
    // same lot all share the same "reminder #N".
    if (queuedThisLot > 0) {
      lot.reminderCount += 1;
      await lot.save();
    }
  }
  return { queued, skipped };
}

module.exports = { enqueueBroadcast, randomBetween };

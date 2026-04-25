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

// Enqueue a template (email or sms) for selected lots. Each message gets a
// staggered sendAfter based on the project's pacing window so they don't all
// blast out at once. Lots in stop statuses / opted-out buyers are skipped.
async function enqueueBroadcast({ lotIds, templateId, isReminder = false, startAt = null }) {
  const template = await Template.findById(templateId);
  if (!template) throw new Error('Template not found');

  const lots = await Lot.find({ _id: { $in: lotIds } }).populate('project');

  const setting = await Setting.getSingleton();
  const owner = setting.owner || {};

  const queued = [];
  const skipped = [];

  // Group by project so pacing is per-project
  const byProject = new Map();
  for (const lot of lots) {
    const pid = String(lot.project._id);
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(lot);
  }

  const now = startAt ? new Date(startAt) : new Date();

  for (const [pid, projectLots] of byProject) {
    const project = projectLots[0].project;
    let cursor = new Date(now.getTime());

    for (const lot of projectLots) {
      if (Lot.STOP_STATUSES.includes(lot.status)) {
        skipped.push({ lotId: String(lot._id), reason: `status=${lot.status}` });
        continue;
      }
      if (lot.reminderCount >= project.maxReminders) {
        skipped.push({ lotId: String(lot._id), reason: `maxReminders reached (${lot.reminderCount}/${project.maxReminders})` });
        continue;
      }
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
        const ctx = renderContext({ project, lot, buyer, owner });
        const rendered = renderTemplate(template, ctx);

        await Outbox.create({
          project: project._id,
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

        const jitter = randomBetween(project.pacing.minSec, project.pacing.maxSec);
        cursor = new Date(cursor.getTime() + jitter * 1000);
      }
    }
  }
  return { queued, skipped };
}

module.exports = { enqueueBroadcast, randomBetween };

const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const Setting = require('../models/Setting');
const Project = require('../models/Project');
const { sendEmail } = require('../services/mailer');
const { sendSms } = require('../services/sms');
const { isWithinSendWindow, nextSendOpening, resolveScheduleTimezone, formatInTimezone } = require('../services/sendWindow');
const { logStatusChange } = require('../services/lotEventLogger');

const POLL_MS = 10_000;
let timer = null;
let running = false;

async function drainOnce() {
  if (running) return;
  running = true;
  try {
    const setting = await Setting.getSingleton();
    if (setting.senderPaused) return;

    const now = new Date();
    const timezone = resolveScheduleTimezone(setting);
    const pendingFilter = { status: 'pending', sendAfter: { $lte: now } };
    // Reminder holds: the master switch parks every reminder; a per-project
    // pause parks that project's reminders (they stay pending and go out when
    // resumed). Manual sends always go, and so does a row the owner forced
    // with "Send now".
    let hold = null;
    if (setting.remindersPaused) {
      hold = { isReminder: { $ne: true } };
    } else {
      const pausedProjectIds = await Project.find({ remindersPaused: true }).distinct('_id');
      if (pausedProjectIds.length) {
        hold = { $or: [{ isReminder: { $ne: true } }, { project: { $nin: pausedProjectIds } }] };
      }
    }
    if (hold) pendingFilter.$or = [{ sendNow: true }, hold];
    const batch = await Outbox.find(pendingFilter)
      .sort({ sendAfter: 1 })
      .limit(20);

    for (const row of batch) {
      // Try to atomically claim the row
      const claimed = await Outbox.findOneAndUpdate(
        { _id: row._id, status: 'pending' },
        { $set: { status: 'sending' }, $inc: { attempts: 1 } },
        { new: true }
      );
      if (!claimed) continue;

      const lot = await Lot.findById(claimed.lot).populate('project');
      if (!lot) {
        claimed.status = 'failed';
        claimed.lastError = 'lot deleted';
        await claimed.save();
        continue;
      }

      // Guard rails — pacing/limits/quiet hours all live on the global Setting
      const sched = setting.schedule || {};
      if (Lot.STOP_STATUSES.includes(lot.status)) {
        claimed.status = 'cancelled';
        claimed.lastError = `lot status=${lot.status}`;
        await claimed.save();
        continue;
      }
      // Note: max-reminders cap is enforced at enqueue time. We do NOT re-check
      // it here because lot.reminderCount is bumped immediately after enqueue,
      // so by the time the worker runs the counter already reflects this very
      // round and would falsely look over-quota.
      // Re-check every recipient at send time: anyone who opted out (or was
      // removed) since the row was queued is dropped, and the row is
      // cancelled if nobody is left. A per-lot email keeps going to whoever
      // remains.
      const wanted =
        claimed.recipients && claimed.recipients.length
          ? claimed.recipients
          : [{ buyerIndex: claimed.buyerIndex, address: claimed.to }];
      const live = wanted.filter((r) => {
        const b = lot.buyers[r.buyerIndex];
        return b && !b.optedOut;
      });
      if (!live.length) {
        claimed.status = 'cancelled';
        claimed.lastError = 'buyer opted out or missing';
        await claimed.save();
        continue;
      }
      if (claimed.type === 'email') {
        const to = live.map((r) => r.address || lot.buyers[r.buyerIndex].email).filter(Boolean).join(', ');
        if (to && to !== claimed.to) claimed.to = to;
      }
      const logRecipients = live.map((r) => ({
        buyerIndex: r.buyerIndex,
        role: r.role || lot.buyers[r.buyerIndex].role || '',
        name: r.name || lot.buyers[r.buyerIndex].name || '',
        address: r.address || claimed.to,
      }));
      if (!claimed.sendNow && !isWithinSendWindow(sched.sendWindows, new Date(), timezone)) {
        // Outside the send window (evaluated in the schedule's timezone, never
        // the server clock). Defer to the next opening; if every day is
        // disabled, nudge 30 minutes and look again.
        const next = nextSendOpening(sched.sendWindows, new Date(), timezone);
        claimed.status = 'pending';
        claimed.sendAfter = next || new Date(Date.now() + 30 * 60 * 1000);
        await claimed.save();
        if (next) console.log(`[sender] outside send window; deferred ${claimed.type} to ${formatInTimezone(next, timezone)}`);
        continue;
      }

      try {
        let providerId = '';
        if (claimed.type === 'email') {
          const info = await sendEmail({
            to: claimed.to,
            subject: claimed.renderedSubject,
            html: claimed.renderedBody,
            text: claimed.renderedText,
            highImportance: !!setting.emailHighImportance,
          });
          providerId = info.messageId;
        } else {
          const info = await sendSms({ to: claimed.to, body: claimed.renderedBody });
          providerId = info.messageId;
        }

        claimed.status = 'sent';
        claimed.lastError = '';
        await claimed.save();

        await MessageLog.create({
          project: lot.project._id,
          lot: lot._id,
          buyerIndex: claimed.buyerIndex,
          type: claimed.type,
          direction: 'out',
          to: claimed.to,
          subject: claimed.renderedSubject,
          body: claimed.renderedBody,
          status: 'sent',
          providerId,
          scheduledFor: claimed.sendAfter,
          sentAt: new Date(),
          isReminder: claimed.isReminder,
          reminderIndex: claimed.reminderIndex,
          sendGroup: claimed.sendGroup || '',
          recipients: logRecipients,
        });

        // reminderCount is incremented per-lot at enqueue time, not here.
        lot.lastContactedAt = new Date();
        lot.nextReminderAt = new Date(
          Date.now() + (sched.reminderIntervalDays || 14) * 24 * 60 * 60 * 1000
        );
        const wasPending = lot.status === 'pending';
        if (wasPending) lot.status = 'contacted';
        await lot.save();
        if (wasPending) {
          await logStatusChange({
            lot,
            project: lot.project._id,
            fromStatus: 'pending',
            toStatus: 'contacted',
            actor: 'sender_worker',
            message: `First send dispatched (${claimed.type}).`,
          });
        }
      } catch (err) {
        console.warn('[sender] send failed', err.message);
        const errMsg = err.message || String(err);
        claimed.status = 'failed';
        claimed.lastError = errMsg;
        await claimed.save();
        await MessageLog.create({
          project: lot.project._id,
          lot: lot._id,
          buyerIndex: claimed.buyerIndex,
          type: claimed.type,
          direction: 'out',
          to: claimed.to,
          subject: claimed.renderedSubject,
          body: claimed.renderedBody,
          status: 'failed',
          error: errMsg,
          scheduledFor: claimed.sendAfter,
          isReminder: claimed.isReminder,
          reminderIndex: claimed.reminderIndex,
          sendGroup: claimed.sendGroup || '',
          recipients: logRecipients,
        });

        // Treat invalid-recipient errors as a buyer-email problem so the UI
        // can flag it. Covers SMTP 550/553 ("no such user", "invalid
        // recipient", "address rejected") and Twilio "invalid To number".
        if (looksLikeBadRecipient(errMsg, claimed.type)) {
          lot.bounceCount = (lot.bounceCount || 0) + 1;
          lot.lastBounceAt = new Date();
          lot.lastBounceError = `${claimed.type === 'email' ? 'Email' : 'SMS'} to ${claimed.to} rejected: ${errMsg.slice(0, 240)}`;
          await lot.save();
        }
      }
    }
  } finally {
    running = false;
  }
}

function looksLikeBadRecipient(errMsg, type) {
  const m = String(errMsg || '').toLowerCase();
  if (!m) return false;
  if (type === 'email') {
    return (
      m.includes('550') ||
      m.includes('553') ||
      m.includes('554') ||
      m.includes('no such user') ||
      m.includes('user unknown') ||
      m.includes('does not exist') ||
      m.includes('mailbox unavailable') ||
      m.includes('invalid recipient') ||
      m.includes('recipient rejected') ||
      m.includes('address rejected') ||
      m.includes('bad address') ||
      m.includes('invalid address') ||
      m.includes('could not be delivered')
    );
  }
  // sms
  return (
    m.includes('invalid to') ||
    m.includes('invalid phone') ||
    m.includes('not a valid phone') ||
    m.includes('21211') || // twilio: invalid 'To' number
    m.includes('21614')    // twilio: 'To' number is not a valid mobile number
  );
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    drainOnce().catch((e) => console.error('[sender] drain error', e));
  }, POLL_MS);
  console.log('[sender] worker started, polling every', POLL_MS, 'ms');
}

module.exports = { start, drainOnce };

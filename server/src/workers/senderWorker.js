const Outbox = require('../models/Outbox');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const Setting = require('../models/Setting');
const { sendEmail } = require('../services/mailer');
const { sendSms } = require('../services/sms');

const POLL_MS = 10_000;
let timer = null;
let running = false;

function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours?.enabled) return false;
  const [sh, sm] = (quietHours.start || '').split(':').map((n) => Number(n));
  const [eh, em] = (quietHours.end || '').split(':').map((n) => Number(n));
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  // Quiet window can wrap midnight (e.g. 21:00 → 08:00)
  if (startMins <= endMins) return mins >= startMins && mins < endMins;
  return mins >= startMins || mins < endMins;
}

async function drainOnce() {
  if (running) return;
  running = true;
  try {
    const setting = await Setting.getSingleton();
    if (setting.senderPaused) return;

    const now = new Date();
    const batch = await Outbox.find({ status: 'pending', sendAfter: { $lte: now } })
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
      const maxReminders = sched.maxReminders ?? 3;
      if (Lot.STOP_STATUSES.includes(lot.status)) {
        claimed.status = 'cancelled';
        claimed.lastError = `lot status=${lot.status}`;
        await claimed.save();
        continue;
      }
      if (lot.reminderCount >= maxReminders) {
        claimed.status = 'cancelled';
        claimed.lastError = `max reminders reached`;
        await claimed.save();
        continue;
      }
      const buyer = lot.buyers[claimed.buyerIndex];
      if (!buyer || buyer.optedOut) {
        claimed.status = 'cancelled';
        claimed.lastError = 'buyer opted out or missing';
        await claimed.save();
        continue;
      }
      if (inQuietHours(sched.quietHours, new Date())) {
        // defer by 30 min
        claimed.status = 'pending';
        claimed.sendAfter = new Date(Date.now() + 30 * 60 * 1000);
        await claimed.save();
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
        });

        lot.reminderCount += 1;
        lot.lastContactedAt = new Date();
        lot.nextReminderAt = new Date(
          Date.now() + (sched.reminderIntervalDays || 14) * 24 * 60 * 60 * 1000
        );
        if (lot.status === 'pending') lot.status = 'contacted';
        await lot.save();
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

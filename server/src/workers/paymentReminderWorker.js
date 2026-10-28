const cron = require('node-cron');
const env = require('../config/env');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const schedule = require('../services/contracts/schedule');

// Monitoring payment emails on a schedule (hourly at minute 23), only inside
// the send window (sendWindow.isWithinSendWindow, falling back to 9:00–18:00):
//  - "upcoming payment" reminder reminderDaysBefore days before
//    billing.currentPeriodEnd (schedule.isReminderDue), claimed per period on
//    reminders.lastRemindedPeriodEnd; claim reverted (CAS) if the send fails
//  - past_due contracts get the failed-payment email in that slot instead
//    ("your last payment didn't go through, the next one is coming"), same claim
//  - "card expires before the next charge" (schedule.cardExpiresBefore), once
//    per expiry (reminders.lastCardExpiryNoticeFor)
//  - one-time "set up your payment" nudge 3 days after signing for contracts
//    still awaiting_payment (schedule.isNudgeDue, paymentSetupNudgeSentAt)
// Gates live in emails.sendContractEmail; the worker short-circuits the
// reminder + card passes with {skipped:'reminders_disabled'} when the global
// toggle is off (the nudge still runs — it is not a reminder). Contracts whose
// own reminders are off, or that are cancelling at period end, are never picked.
//
// Owner: reminders track. Same worker pattern as docusignPoller. Invoice
// receipts and per-invoice failure emails are event-driven (Stripe webhook),
// never sent from here.

const MS_DAY = 24 * 60 * 60 * 1000;
const NUDGE_AFTER_DAYS = 3;
const BATCH_LIMIT = 200;

let running = false;

// Lazy so the pure helper below can be required (tests) without models.
const models = () => ({
  AlarmContract: require('../models/AlarmContract'),
  ContractPayment: require('../models/ContractPayment'),
  Setting: require('../models/Setting'),
});
const emails = () => require('../services/contracts/emails');

/**
 * What is due for one contract right now (pure).
 * @param {object} c lean AlarmContract
 * @param {{now: Date, tz: string, daysBefore: number, remindersOn: boolean}} o
 * @returns {{reminder: 'upcoming_payment'|'payment_failed'|null, periodEnd: Date|null,
 *   cardNotice: string|null, nudge: boolean}}
 */
function dueActions(c, { now, tz, daysBefore, remindersOn }) {
  const out = { reminder: null, periodEnd: null, cardNotice: null, nudge: false };
  const b = c.billing || {};
  const rem = c.reminders || {};
  const billed = ['active', 'past_due'].includes(c.status);
  const remindable = remindersOn && billed && rem.enabled !== false && !b.cancelAtPeriodEnd && b.currentPeriodEnd;
  if (remindable) {
    const due = schedule.isReminderDue({
      periodEnd: b.currentPeriodEnd,
      daysBefore,
      now,
      tz,
      lastRemindedPeriodEnd: rem.lastRemindedPeriodEnd,
    });
    if (due) {
      out.reminder = c.status === 'past_due' ? 'payment_failed' : 'upcoming_payment';
      out.periodEnd = new Date(b.currentPeriodEnd);
    }
    const key = schedule.cardExpiryKey({ expMonth: b.pmExpMonth, expYear: b.pmExpYear });
    if (key && key !== rem.lastCardExpiryNoticeFor &&
        schedule.cardExpiresBefore({ expMonth: b.pmExpMonth, expYear: b.pmExpYear }, b.currentPeriodEnd)) {
      out.cardNotice = key;
    }
  }
  if (c.status === 'awaiting_payment' && !c.needsAttention && c.portal && c.portal.invitedAt) {
    out.nudge = schedule.isNudgeDue({ signedAt: c.signedAt, now, nudgeSentAt: c.paymentSetupNudgeSentAt, days: NUDGE_AFTER_DAYS });
  }
  return out;
}

// Claim → send → keep or revert. `claim` is the compare-and-set filter extra
// and `set` the fields it writes; `revert` puts the previous values back,
// guarded on our own claim so a newer claim is never undone.
async function claimAndSend(c, { claim, set, revert, send }) {
  const { AlarmContract } = models();
  const won = await AlarmContract.findOneAndUpdate({ _id: c._id, ...claim }, { $set: set }, { new: true }).lean();
  if (!won) return 'claimed';
  let r;
  try {
    r = await send(won);
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (r && r.ok) return 'sent';
  // A missing address won't fix itself by retrying hourly; everything else
  // (SMTP down, toggled off mid-run) gives the slot back.
  if (r && r.skipped === 'no_recipient') return 'skipped';
  await AlarmContract.updateOne({ _id: c._id, ...set }, { $set: revert });
  return r && r.skipped ? 'skipped' : 'failed';
}

async function latestOpenPayment(contractId) {
  const { ContractPayment } = models();
  return ContractPayment.findOne({ contract: contractId, status: { $in: ['open', 'uncollectible'] } })
    .sort({ periodStart: -1, invoiceCreatedAt: -1 })
    .lean();
}

/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{skipped?: string, reminders?: number, cardNotices?: number, nudges?: number, failed?: number}>}
 */
async function runOnce({ now = new Date() } = {}) {
  if (running) return { skipped: 'running' };
  if (!env.smtp.configured) return { skipped: 'smtp_not_configured' };
  running = true;
  try {
    const { AlarmContract, Setting } = models();
    const setting = await Setting.getSingleton();
    const tz = resolveScheduleTimezone(setting);
    const sendWindows = setting.schedule && setting.schedule.sendWindows;
    if (!schedule.isWithinReminderHours({ sendWindows, now, tz })) return { skipped: 'outside_send_window' };

    const alarm = setting.alarm || {};
    const remindersOn = alarm.paymentRemindersEnabled !== false;
    const daysBefore = Math.min(14, Math.max(1, Number(alarm.reminderDaysBefore) || 3));
    const summary = { reminders: 0, cardNotices: 0, nudges: 0, failed: 0 };
    const tally = (outcome, key) => {
      if (outcome === 'sent') summary[key] += 1;
      else if (outcome === 'failed') summary.failed += 1;
    };
    const send = (c, kind, data) =>
      emails().sendContractEmail({ contract: c, kind, data, actor: 'reminder_worker' });

    // ---- 1. Upcoming payment / past-due reminder + card expiry -------------
    if (remindersOn) {
      // Charges within the reminder horizon (+1 day for the timezone edge),
      // plus anything whose card may lapse before the next charge.
      const horizon = new Date(now.getTime() + (daysBefore + 1) * MS_DAY);
      const candidates = await AlarmContract.find({
        isCurrent: true,
        status: { $in: ['active', 'past_due'] },
        'reminders.enabled': { $ne: false },
        'billing.cancelAtPeriodEnd': { $ne: true },
        'billing.currentPeriodEnd': { $gt: now },
        $or: [{ 'billing.currentPeriodEnd': { $lte: horizon } }, { 'billing.pmExpYear': { $ne: null } }],
      })
        .limit(BATCH_LIMIT * 5)
        .lean();

      for (const c of candidates) {
        const due = dueActions(c, { now, tz, daysBefore, remindersOn });
        if (due.reminder) {
          const prev = c.reminders || {};
          const outcome = await claimAndSend(c, {
            claim: {
              'reminders.lastRemindedPeriodEnd': { $ne: due.periodEnd },
              'billing.currentPeriodEnd': due.periodEnd,
            },
            set: { 'reminders.lastRemindedPeriodEnd': due.periodEnd, 'reminders.lastRemindedAt': now },
            revert: {
              'reminders.lastRemindedPeriodEnd': prev.lastRemindedPeriodEnd || null,
              'reminders.lastRemindedAt': prev.lastRemindedAt || null,
            },
            send: async (fresh) => {
              if (due.reminder === 'upcoming_payment') {
                return send(fresh, 'upcoming_payment', { chargeDate: due.periodEnd });
              }
              const payment = await latestOpenPayment(fresh._id);
              return send(fresh, 'payment_failed', {
                payment: payment || {},
                failureMessage: (payment && payment.failureMessage) || fresh.billing.lastFailureMessage || '',
                nextAttemptAt: (payment && payment.nextPaymentAttempt) || null,
              });
            },
          });
          tally(outcome, 'reminders');
        }
        if (due.cardNotice) {
          const prevKey = (c.reminders && c.reminders.lastCardExpiryNoticeFor) || '';
          const outcome = await claimAndSend(c, {
            claim: { 'reminders.lastCardExpiryNoticeFor': { $ne: due.cardNotice } },
            set: { 'reminders.lastCardExpiryNoticeFor': due.cardNotice },
            revert: { 'reminders.lastCardExpiryNoticeFor': prevKey },
            send: (fresh) =>
              send(fresh, 'card_expiring', {
                expMonth: fresh.billing.pmExpMonth,
                expYear: fresh.billing.pmExpYear,
                chargeDate: fresh.billing.currentPeriodEnd,
              }),
          });
          tally(outcome, 'cardNotices');
        }
      }
    }

    // ---- 2. One-time payment-setup nudge ------------------------------------
    const signedBefore = new Date(now.getTime() - NUDGE_AFTER_DAYS * MS_DAY);
    const unpaid = await AlarmContract.find({
      isCurrent: true,
      status: 'awaiting_payment',
      needsAttention: { $in: ['', null] },
      paymentSetupNudgeSentAt: null,
      'portal.invitedAt': { $ne: null },
      signedAt: { $ne: null, $lte: signedBefore },
    })
      .limit(BATCH_LIMIT)
      .lean();
    for (const c of unpaid) {
      if (!dueActions(c, { now, tz, daysBefore, remindersOn }).nudge) continue;
      const outcome = await claimAndSend(c, {
        claim: { paymentSetupNudgeSentAt: null, status: 'awaiting_payment' },
        set: { paymentSetupNudgeSentAt: now },
        revert: { paymentSetupNudgeSentAt: null },
        send: (fresh) => send(fresh, 'payment_nudge', {}),
      });
      tally(outcome, 'nudges');
    }

    if (summary.reminders || summary.cardNotices || summary.nudges || summary.failed) {
      console.log(
        `[payment-reminders] reminders ${summary.reminders}, card notices ${summary.cardNotices}, nudges ${summary.nudges}, failed ${summary.failed}`
      );
    }
    return remindersOn ? summary : { ...summary, skipped: 'reminders_disabled' };
  } finally {
    running = false;
  }
}

function start() {
  if (!env.stripe.configured) {
    console.log('[payment-reminders] worker not starting — Stripe not configured');
    return;
  }
  cron.schedule('23 * * * *', () => {
    runOnce().catch((e) => console.error('[payment-reminders]', e.message));
  });
  console.log('[payment-reminders] worker started (hourly at :23, inside the send window)');
}

module.exports = { start, runOnce, dueActions };

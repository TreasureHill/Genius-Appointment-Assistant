const cron = require('node-cron');
const AlarmContract = require('../models/AlarmContract');
const { PACKAGES } = require('../services/contracts/pricing');
const envelopeSync = require('../services/contracts/envelopeSync');
const portalTokens = require('../services/contracts/portalTokens');

// Signed-contract follow-through that must not depend on DocuSign or Stripe
// being configured (every 15 min, at :07/:22/:37/:52):
//  1. Welcome emails that never went out. completeEnvelope /
//     completePaperSigning / setPackageManually call
//     portalTokens.inviteContractUsers, which never throws for a failed send:
//     it gives the portal.invitedAt claim back and counts portal.inviteFailures.
//     Without this pass an SMTP outage at the moment of signing left the
//     homeowner with no login, no payment link and (since the nudge needs
//     invitedAt) no reminder either, until staff noticed. Retries back off
//     (15 min doubling, capped at 6 h) and stop after MAX_INVITE_FAILURES;
//     staff "Resend invite" always works.
//  2. Paper-contract completion tails that threw (a DB error while creating
//     portal users …). The DocuSign poller retries envelope tails, but it is a
//     no-op on a paper-only install, so paper tails are retried here.
//
// Same worker pattern as docusignPoller: `running` re-entrancy flag, boot run
// after 45 s, runOnce() returns a summary and logs only when it did work.

const MS_MIN = 60 * 1000;
const FIRST_BACKOFF_MS = 15 * MS_MIN;
const MAX_BACKOFF_MS = 6 * 60 * MS_MIN;
const MAX_INVITE_FAILURES = 10;
const BATCH_LIMIT = 50;

let running = false;

/** How long to wait after the n-th failed automatic invite (pure). */
function inviteBackoffMs(failures) {
  if (!failures || failures < 1) return 0;
  return Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

/** Is an automatic welcome retry due for this contract now? (pure) */
function inviteRetryDue(c, now = new Date()) {
  const p = (c && c.portal) || {};
  if (p.invitedAt) return false;
  const failures = p.inviteFailures || 0;
  if (failures >= MAX_INVITE_FAILURES) return false;
  if (!failures || !p.lastInviteFailureAt) return true;
  return now.getTime() - new Date(p.lastInviteFailureAt).getTime() >= inviteBackoffMs(failures);
}

/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{skipped?: 'running', invited: number, inviteFailed: number, tailsRetried: number, failed: number}>}
 */
async function runOnce({ now = new Date() } = {}) {
  if (running) return { skipped: 'running' };
  running = true;
  const summary = { invited: 0, inviteFailed: 0, tailsRetried: 0, failed: 0 };
  try {
    // ---- 1. Signed, package known, completion done, but nobody invited ------
    const pending = await AlarmContract.find({
      isCurrent: true,
      status: { $in: ['awaiting_payment', 'active', 'past_due', 'unpaid'] },
      'envelope.status': 'completed',
      'envelope.completionDoneAt': { $ne: null },
      package: { $in: Object.keys(PACKAGES) },
      needsAttention: { $in: ['', null] },
      'portal.invitedAt': null,
      'portal.inviteFailures': { $not: { $gte: MAX_INVITE_FAILURES } },
      // No email on file can't fix itself; staff add one (update contact).
      purchasers: { $elemMatch: { email: { $nin: ['', null] } } },
    })
      .select('_id portal')
      .limit(BATCH_LIMIT)
      .lean();
    for (const c of pending) {
      if (!inviteRetryDue(c, now)) continue;
      try {
        const r = await portalTokens.inviteContractUsers(c, { actor: 'system' });
        if (r.sent > 0) summary.invited += 1;
        else if (!r.skipped) summary.inviteFailed += 1;
      } catch (err) {
        summary.failed += 1;
        console.warn('[contract-tail] welcome retry failed', String(c._id), err.code || '', err.message);
      }
    }

    // ---- 2. Paper completion tails that never finished ----------------------
    const staleClaim = new Date(now.getTime() - envelopeSync.CLAIM_STALE_MS);
    const tails = await AlarmContract.find({
      'envelope.status': 'completed',
      'envelope.completionDoneAt': null,
      $and: [
        { $or: [{ signingMode: 'paper' }, { 'envelope.id': { $in: [null, ''] } }] },
        { $or: [{ 'envelope.completionClaimedAt': null }, { 'envelope.completionClaimedAt': { $lt: staleClaim } }] },
      ],
    })
      .select('_id')
      .limit(BATCH_LIMIT)
      .lean();
    for (const c of tails) {
      try {
        const r = await envelopeSync.completeEnvelope(c._id, { actor: 'system' });
        if (r && r.done) summary.tailsRetried += 1;
      } catch (err) {
        summary.failed += 1;
        console.warn('[contract-tail] paper completion retry failed', String(c._id), err.code || '', err.message);
      }
    }

    if (summary.invited || summary.inviteFailed || summary.tailsRetried || summary.failed) {
      console.log(
        `[contract-tail] welcome emails sent ${summary.invited}, still failing ${summary.inviteFailed}, paper tails finished ${summary.tailsRetried}, errors ${summary.failed}`
      );
    }
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  const tick = () => runOnce().catch((e) => console.error('[contract-tail]', e.message));
  cron.schedule('7,22,37,52 * * * *', tick);
  setTimeout(tick, 45_000).unref();
  console.log('[contract-tail] worker started (every 15 min: welcome email retries, paper completion retries)');
}

module.exports = { start, runOnce, inviteRetryDue, inviteBackoffMs, MAX_INVITE_FAILURES };

const cron = require('node-cron');
const env = require('../config/env');
const AlarmContract = require('../models/AlarmContract');
const Setting = require('../models/Setting');
const docusign = require('../services/contracts/docusign');
const envelopeSync = require('../services/contracts/envelopeSync');

// DocuSign fallback poller (every 20 min, `*/20 * * * *`): one batched
// docusign.listStatusChanges for current contracts whose envelope is
// sent/delivered and hasn't heard from Connect or a sync in 15 min, then
// envelopeSync.applyEnvelopeStatus(id, {actor:'docusign_poller'}) for each
// change; also retries completed envelopes with completionDoneAt null (stale
// claim). Updates Setting.alarm.lastDocusignPollAt.
//
// Connect is the fast path; this is what keeps local dev (no public https
// URL, so no eventNotification at all) and missed Connect deliveries
// working. DocuSign forbids polling one envelope more often than every 15
// minutes, hence the quiet period and the single batched list call.
//
// Pattern: start() is a logged no-op when DocuSign isn't configured;
// `running` re-entrancy flag; boot run after 30 s via setTimeout(...).unref();
// runOnce() returns a summary and logs only when it did work.

const QUIET_MS = 15 * 60 * 1000;
const STUCK_LIMIT = 25;
const MAX_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

let running = false;

function minDate(list) {
  let min = null;
  for (const d of list) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (!Number.isNaN(t) && (min === null || t < min)) min = t;
  }
  return min === null ? null : new Date(min);
}

/**
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{skipped?: 'running'|'not_configured', checked?: number, changed?: number, retried?: number, failed?: number}>}
 */
async function runOnce({ now = new Date() } = {}) {
  if (running) return { skipped: 'running' };
  if (!env.docusign.configured) return { skipped: 'not_configured' };
  running = true;
  const summary = { checked: 0, changed: 0, retried: 0, failed: 0 };
  try {
    // ---- 1. Envelopes still out for signature that have gone quiet --------
    const quietBefore = new Date(now.getTime() - QUIET_MS);
    const out = await AlarmContract.find({
      'envelope.status': { $in: ['sent', 'delivered'] },
      'envelope.id': { $nin: [null, ''] },
      $and: [
        { $or: [{ 'envelope.lastConnectAt': null }, { 'envelope.lastConnectAt': { $lt: quietBefore } }] },
        { $or: [{ 'envelope.lastSyncedAt': null }, { 'envelope.lastSyncedAt': { $lt: quietBefore } }] },
      ],
    })
      .select('_id envelope.id envelope.status envelope.sentAt')
      .lean();

    if (out.length) {
      summary.checked = out.length;
      const byId = new Map(out.map((c) => [String(c.envelope.id), c]));
      const oldest = minDate(out.map((c) => c.envelope.sentAt));
      const fromDate = new Date(Math.max((oldest || now).getTime() - 60 * 60 * 1000, now.getTime() - MAX_LOOKBACK_MS));
      const changes = await docusign.listStatusChanges({ envelopeIds: [...byId.keys()], fromDate });
      // Stamp every envelope we asked about, changed or not, so the next run
      // leaves it alone for another quiet period.
      await AlarmContract.updateMany(
        { _id: { $in: out.map((c) => c._id) } },
        { $set: { 'envelope.lastSyncedAt': now } }
      );
      for (const ch of changes) {
        const mine = byId.get(String(ch.envelopeId));
        if (!mine || !ch.status || ch.status === mine.envelope.status) continue;
        try {
          const r = await envelopeSync.applyEnvelopeStatus(ch.envelopeId, { actor: 'docusign_poller' });
          if (r && r.changed) summary.changed += 1;
        } catch (err) {
          summary.failed += 1;
          console.warn('[docusign] poller sync failed for an envelope', err.code || '', err.message);
        }
      }
    }

    // ---- 2. Completion tails that never finished ----------------------------
    // (crashed run, DocuSign download error). Claims older than
    // envelopeSync.CLAIM_STALE_MS are free to take again. A welcome email
    // that failed to SEND does not leave the tail unfinished; those are
    // retried by workers/contractTailWorker (which also covers paper tails).
    const staleClaim = new Date(now.getTime() - envelopeSync.CLAIM_STALE_MS);
    const stuck = await AlarmContract.find({
      'envelope.status': 'completed',
      'envelope.completionDoneAt': null,
      $or: [{ 'envelope.completionClaimedAt': null }, { 'envelope.completionClaimedAt': { $lt: staleClaim } }],
    })
      .select('_id')
      .sort({ 'envelope.completedAt': 1 })
      .limit(STUCK_LIMIT)
      .lean();
    for (const c of stuck) {
      try {
        const r = await envelopeSync.completeEnvelope(c._id, { actor: 'docusign_poller' });
        if (r && r.done) summary.retried += 1;
      } catch (err) {
        summary.failed += 1;
        console.warn('[docusign] completion retry failed', String(c._id), err.code || '', err.message);
      }
    }

    await Setting.updateOne({ key: 'singleton' }, { $set: { 'alarm.lastDocusignPollAt': now } }).catch(() => {});
    if (summary.changed || summary.retried || summary.failed) {
      console.log(
        `[docusign] poll: checked ${summary.checked}, changed ${summary.changed}, completions retried ${summary.retried}, failed ${summary.failed}`
      );
    }
    return summary;
  } finally {
    running = false;
  }
}

function start() {
  if (!env.docusign.configured) {
    console.log('[docusign] poller not starting — DocuSign not configured');
    return;
  }
  const tick = () =>
    runOnce().catch((e) => console.error('[docusign] poller error', e.code || '', e.message));
  cron.schedule('*/20 * * * *', tick);
  setTimeout(tick, 30_000).unref();
  console.log(
    `[docusign] poller started (every 20 min${env.docusign.connectEnabled ? '; Connect is the primary path' : '; Connect off, polling only'})`
  );
}

module.exports = { start, runOnce };

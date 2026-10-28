const cron = require('node-cron');
const env = require('../config/env');
const AlarmContract = require('../models/AlarmContract');
const Setting = require('../models/Setting');
const billing = require('../services/contracts/billing');
const { stripe } = require('../services/contracts/stripeClient');
const { listRetryableWebhookEvents, retryWebhookEvent } = require('../services/contracts/webhookEvents');
const { resolveScheduleTimezone } = require('../services/sendWindow');

// Stripe reconciler:
//  - nightly at 03:17 in the schedule timezone: billing.reconcileContract for
//    every contract with a customer, one at a time
//  - hourly: only contracts in checkout_open / incomplete / past_due
//  - retries failed / stale WebhookEvents (webhookEvents.listRetryableWebhookEvents
//    → re-retrieve the event → billing.applyStripeEvent) and unsent receipt /
//    failure email claims (≤ 3 attempts)
//  - every correction is a 'reconcile_fix' ContractEvent (logged inside
//    reconcileContract); updates Setting.alarm.lastStripeReconcileAt
//
// Webhooks are the primary path; this is the safety net. A rising fix count
// means webhook delivery is broken (check the endpoint in the Stripe dashboard).
//
// Owner: Stripe track. Same worker pattern as docusignPoller.

const HOT_STATUSES = ['checkout_open', 'incomplete', 'past_due'];

let running = false;

/**
 * @param {{scope?: 'all'|'hot'}} [opts] 'hot' = the hourly subset
 * @returns {Promise<{skipped?: string, contracts?: number, fixes?: number, failed?: number, webhookRetries?: number, emailRetries?: number}>}
 */
async function runOnce({ scope = 'all' } = {}) {
  if (running) return { skipped: 'running' };
  if (!env.stripe.configured) return { skipped: 'not_configured' };
  running = true;
  try {
    const q =
      scope === 'hot'
        ? { 'billing.status': { $in: HOT_STATUSES } }
        : { 'billing.customerId': { $nin: ['', null] } };
    const ids = await AlarmContract.find(q).select('_id number').sort({ updatedAt: 1 }).lean();
    let fixes = 0;
    let failed = 0;
    // One at a time: a few hundred contracts × a handful of calls stays well
    // inside Stripe's rate limit, and a crash mid-run loses nothing.
    for (const c of ids) {
      try {
        const r = await billing.reconcileContract(c._id, { actor: 'stripe_reconciler' });
        fixes += r.fixes;
      } catch (err) {
        failed += 1;
        console.error(`[stripe] reconcile ${c.number || c._id} failed:`, err.message);
      }
    }

    // Webhook deliveries that failed (or died mid-processing): fetch the event
    // again (the stored row has no payload) and reapply it.
    let webhookRetries = 0;
    const rows = await listRetryableWebhookEvents({ provider: 'stripe' });
    for (const row of rows) {
      const r = await retryWebhookEvent(row, async () => {
        const event = await stripe().events.retrieve(row.eventId);
        return billing.applyStripeEvent(event);
      });
      if (r.status === 200) webhookRetries += 1;
    }

    const emailRetries = await billing.retryPendingEmails({ actor: 'stripe_reconciler' });

    await Setting.updateOne({ key: 'singleton' }, { $set: { 'alarm.lastStripeReconcileAt': new Date() } });
    const summary = { scope, contracts: ids.length, fixes, failed, webhookRetries, emailRetries };
    if (fixes || failed || webhookRetries || emailRetries) console.log('[stripe] reconcile', JSON.stringify(summary));
    return summary;
  } finally {
    running = false;
  }
}

const tick = (scope) => () => runOnce({ scope }).catch((e) => console.error(`[stripe] reconcile (${scope}) error`, e.message));

async function schedule() {
  let tz = resolveScheduleTimezone({});
  try {
    tz = resolveScheduleTimezone(await Setting.getSingleton());
  } catch (e) {
    console.warn('[stripe] reconciler: could not read the schedule timezone, using', tz, '-', e.message);
  }
  // Nightly full pass. The timezone is read once at boot; a change in
  // Settings applies after the next restart (same as the other cron workers).
  cron.schedule('17 3 * * *', tick('all'), { timezone: tz });
  // Hourly hot pass (skipped automatically while the nightly run holds the flag).
  cron.schedule('47 * * * *', tick('hot'));
  console.log(`[stripe] reconciler started (nightly 03:17 ${tz}, hourly for checkout_open / incomplete / past_due)`);
}

function start() {
  if (!env.stripe.configured) {
    console.log('[stripe] reconciler not starting — Stripe not configured');
    return;
  }
  schedule().catch((e) => console.error('[stripe] reconciler failed to start', e.message));
  // A hot pass shortly after boot picks up anything missed while we were down.
  setTimeout(tick('hot'), 45_000).unref();
}

module.exports = { start, runOnce, HOT_STATUSES };

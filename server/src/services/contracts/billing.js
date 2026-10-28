const mongoose = require('mongoose');
const env = require('../../config/env');
const AlarmContract = require('../../models/AlarmContract');
const ContractPayment = require('../../models/ContractPayment');
const ContractEvent = require('../../models/ContractEvent');
const { contractError } = require('./errors');
const { requireStripe, assertCatalog } = require('./stripeClient');
const { assertCan, mapStripeSubStatus, LIVE_BILLING_STATUSES } = require('./status');
const { PACKAGES, isValidPackage, fmtCad } = require('./pricing');
const { logContractEvent } = require('./eventLogger');

// Stripe billing for monitoring contracts: hosted Checkout, Billing Portal,
// cancel, the webhook event handler, reconcile, and the aggregates the
// dashboard reads.
//
// Owner: Stripe track (tests: contractStripe.test.js). The pure helpers at the
// bottom were shipped by the foundation; the owner adds fixtures/tests and may
// refine them.
//
// Conventions:
//  - every applyStripeEvent branch re-retrieves the object from Stripe (events
//    arrive out of order and, in dev, unsigned — the payload is only a hint)
//  - writes are upserts / compare-and-set, then AlarmContract.refreshStatus(id)
//  - aggregates are recomputed from ContractPayment (recomputeBillingAggregates),
//    never $inc'd
//  - emails go through emails.sendContractEmail (receipt / payment_failed /
//    canceled / admin_alert) behind the ContractPayment receiptEmail /
//    failureEmail claims

// emails.js / portal code may grow a dependency on this module; require it
// lazily so a cycle can never hand us a half-initialised export object.
const emails = () => require('./emails');

const SUBSCRIPTION_EXPAND = ['default_payment_method'];
// A Checkout Session is reused while it has more than this left.
const SESSION_REUSE_MARGIN_MS = 5 * 60 * 1000;
// Stripe allows expires_at between 30 min and 24 h out; 1 h is plenty to type
// a card number and short enough that abandoned sessions clear the same day.
const SESSION_TTL_S = 60 * 60;
// Email claims: an in-flight claim older than this is assumed to have crashed.
const EMAIL_CLAIM_STALE_MS = 10 * 60 * 1000;
const MAX_EMAIL_ATTEMPTS = 3;
// The reconciler only sends a receipt / failure email it discovered itself
// (missed webhook) when the payment is this recent — rebuilding deleted rows
// must not re-email a year of receipts.
const RECONCILE_EMAIL_WINDOW_MS = 72 * 60 * 60 * 1000;
const FAILURE_EMAIL_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

const idStr = (v) => (v == null ? '' : String((v && v._id) || v));

// When we STARTED reading a Stripe object. Handlers run concurrently (an
// invoice.finalized and an invoice.paid for the same invoice, a
// subscription.updated racing an invoice.paid) and each writes what it read,
// so without a guard an older read can land last and undo a newer one (paid
// back to open, active back to past_due). Every write carries the read time
// and is a compare-and-set against the stored one: a read that started later
// saw at least as new a state, so it wins. Kept as a non-enumerable symbol so
// it never travels into a $set or a log line.
const READ_AT = Symbol('stripeReadAt');
function stampRead(obj, at) {
  if (obj && typeof obj === 'object') Object.defineProperty(obj, READ_AT, { value: at, enumerable: false, configurable: true });
  return obj;
}
const readAtOf = (obj) => (obj && obj[READ_AT]) || null;
// "The stored read time is unset or not newer than `at`."
const notNewerThan = (field, at) => ({ $or: [{ [field]: null }, { [field]: { $lte: at } }] });

const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

async function loadContract(contractOrId) {
  const id = idStr(contractOrId);
  if (!mongoose.isValidObjectId(id)) throw contractError('not_found', 'Contract not found');
  const c = await AlarmContract.findById(id).lean();
  if (!c) throw contractError('not_found', 'Contract not found');
  return c;
}

// Which contract a Stripe object belongs to. The linked subscription id is
// authoritative; then our own metadata (client_reference_id / metadata.contractId);
// then the customer (one Stripe customer per contract).
async function findContract({ subscriptionId, contractId, customerId }) {
  if (subscriptionId) {
    const c = await AlarmContract.findOne({ 'billing.subscriptionId': subscriptionId }).lean();
    if (c) return c;
  }
  if (contractId && mongoose.isValidObjectId(String(contractId))) {
    const c = await AlarmContract.findById(String(contractId)).lean();
    if (c) return c;
  }
  if (customerId) {
    const c = await AlarmContract.findOne({ 'billing.customerId': customerId }).sort({ createdAt: -1 }).lean();
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status bookkeeping
// ---------------------------------------------------------------------------

// Recompute the derived status after a billing write and log what changed:
// 'activated' the first time a contract goes active (mirrored to the lot),
// 'canceled' (mirrored; plus the homeowner email) when it ends, otherwise a
// plain 'subscription_status'. refreshStatus is a compare-and-set, so only
// one concurrent writer sees `changed` and logs.
async function afterBillingWrite(contractId, { actor = 'stripe', actorName = '', notify = true } = {}) {
  const r = await AlarmContract.refreshStatus(contractId);
  if (!r.changed) return r;
  const c = await AlarmContract.findById(contractId).lean();
  if (!c) return r;
  const base = { contract: c, actor, actorName, fromStatus: r.from, toStatus: r.to };
  if (r.to === 'active' && !(await ContractEvent.exists({ contract: c._id, type: 'activated' }))) {
    await logContractEvent({ ...base, type: 'activated', message: 'Monitoring active: first payment received' });
    return r;
  }
  if (r.to === 'canceled') {
    const expired = c.billing.status === 'incomplete_expired';
    const why = expired ? 'the first payment never completed' : c.cancelReason || '';
    await logContractEvent({ ...base, type: 'canceled', message: `Monitoring cancelled${why ? ` (${why})` : ''}` });
    // Nothing was ever billed for an expired first checkout (or a contract
    // closed before payment was set up, notify:false): no email.
    if (!expired && notify) {
      await emails().sendContractEmail({
        contract: c,
        kind: 'canceled',
        data: { atPeriodEnd: Boolean(c.billing.cancelAtPeriodEnd), endsAt: c.billing.endedAt || c.billing.canceledAt, reason: c.cancelReason || '' },
        actor,
        actorName,
      });
    }
    return r;
  }
  await logContractEvent({ ...base, type: 'subscription_status', message: `Billing status ${r.from} → ${r.to}` });
  return r;
}

// Write a (freshly retrieved) subscription onto the contract. Only adopts the
// subscription when the contract has none yet or already has this one — a
// different subscription is the double-subscription case, handled by the
// checkout.session.completed guard. Returns { changed: string[] } (field names
// that differed) or { skipped }.
async function syncSubscription(contract, sub, { actor = 'stripe', actorName = '' } = {}) {
  const linked = contract.billing && contract.billing.subscriptionId;
  if (linked && linked !== sub.id) return { skipped: 'other_subscription', changed: [] };
  const fields = subscriptionFields(sub);
  if (!fields.status) {
    console.warn(`[stripe] unknown subscription status "${sub.status}" on ${sub.id}; mirror left alone`);
    delete fields.status;
  }
  const before = contract.billing || {};
  const changed = Object.keys(fields).filter((k) =>
    fields[k] instanceof Date || before[k] instanceof Date ? !sameTime(fields[k], before[k]) : (before[k] ?? null) !== (fields[k] ?? null)
  );
  if (!linked) changed.push('subscriptionId');
  const $set = { 'billing.subscriptionId': sub.id };
  for (const [k, v] of Object.entries(fields)) $set[`billing.${k}`] = v;
  const customerId = idOf(sub.customer);
  if (customerId && !before.customerId) $set['billing.customerId'] = customerId;
  // Once a subscription exists the checkout session is history.
  if (fields.status && fields.status !== 'checkout_open') $set['billing.checkoutExpiresAt'] = null;
  // Stale-read guard (see READ_AT). Objects that didn't come through
  // retrieveSubscription (tests, fixtures) carry no read time and skip it.
  const readAt = readAtOf(sub);
  const fresher = readAt ? notNewerThan('billing.subscriptionReadAt', readAt) : {};
  if (readAt && before.subscriptionReadAt && new Date(before.subscriptionReadAt).getTime() > readAt.getTime()) {
    return { skipped: 'stale_read', changed: [] };
  }
  if (!changed.length) {
    // Nothing to write, but still record that state as of `readAt` is known,
    // so an older read finishing after this one can't overwrite it.
    if (readAt) await AlarmContract.updateOne({ _id: contract._id, ...fresher }, { $set: { 'billing.subscriptionReadAt': readAt } });
    return { changed };
  }
  if (readAt) $set['billing.subscriptionReadAt'] = readAt;
  const r = await AlarmContract.updateOne(
    { _id: contract._id, 'billing.subscriptionId': { $in: [null, sub.id] }, ...fresher },
    { $set }
  );
  if (!r.matchedCount) {
    const now = await AlarmContract.findById(contract._id).select('billing.subscriptionId').lean();
    const other = now && now.billing && now.billing.subscriptionId && now.billing.subscriptionId !== sub.id;
    return { skipped: other ? 'other_subscription' : 'stale_read', changed: [] };
  }
  await afterBillingWrite(contract._id, { actor, actorName });
  return { changed };
}

async function retrieveSubscription(s, subId) {
  const at = new Date();
  return stampRead(await s.subscriptions.retrieve(subId, { expand: SUBSCRIPTION_EXPAND }), at);
}

// ---------------------------------------------------------------------------
// Checkout / Billing Portal / cancel
// ---------------------------------------------------------------------------

// Find-or-create the contract's one Stripe customer. The idempotency key makes
// a double click (or a retry after a timeout) return the same customer, and
// the compare-and-set keeps whichever id landed first. Customer params come
// from the contract only (not the clicking portal user) so a retry with the
// same key always sends identical params.
async function ensureCustomer(s, c) {
  if (c.billing && c.billing.customerId) return c.billing.customerId;
  const people = (c.purchasers || []).filter((p) => p.name || p.email);
  const primary = people.find((p) => p.email) || people[0] || {};
  const params = {
    name: people.map((p) => p.name).filter(Boolean).join(' & ') || primary.email || c.number,
    email: primary.email || undefined,
    phone: primary.phone || undefined,
    description: `${c.number} · ${c.property.projectName || ''} lot ${c.property.lotNumber || ''}`.trim(),
    metadata: { contractId: String(c._id), contractNumber: c.number, lotId: idStr(c.lot), projectId: idStr(c.project) },
  };
  let opts = { idempotencyKey: `cust-${c._id}` };
  // Dev only: a test clock per customer lets Settings-free renewals be
  // simulated (STRIPE_TEST_CLOCKS=1, test keys). Clock creation can't share
  // the idempotency key, so the compare-and-set below is the guard.
  if (env.stripe.testClocks && env.stripe.mode === 'test') {
    const clock = await s.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: c.number });
    params.test_clock = clock.id;
    opts = {};
  }
  const customer = await s.customers.create(params, opts);
  const r = await AlarmContract.updateOne(
    { _id: c._id, 'billing.customerId': { $in: ['', null] } },
    { $set: { 'billing.customerId': customer.id } }
  );
  if (r.modifiedCount) return customer.id;
  const fresh = await AlarmContract.findById(c._id).select('billing.customerId').lean();
  return (fresh && fresh.billing.customerId) || customer.id;
}

/**
 * Create (or reuse, if > 5 min left) a hosted Checkout Session.
 * mode:'subscription', customer (created with idempotencyKey `cust-${id}`),
 * line_items [{price, quantity:1, tax_rates:[taxRateId]}] — price from the
 * server-side contract.package only — client_reference_id + metadata
 * contractId, subscription_data.metadata, expires_at now+1h,
 * success_url `${appUrl}/portal/pay?contract=:id&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
 * cancel_url `…&checkout=cancel`. Sets billing.status 'checkout_open'.
 * @param {object} contract  AlarmContract doc
 * @param {object} portalUser PortalUser doc (must be linked to the contract)
 * @returns {Promise<{url: string, sessionId: string, reused: boolean}>}
 * @throws not_configured | invalid_state | package_missing | already_subscribed | stripe_catalog_mismatch | no_portal_user
 */
async function createCheckoutForContract(contract, portalUser) {
  const s = requireStripe();
  if (!env.stripe.billable) throw contractError('not_configured', 'Online payment is not set up yet (STRIPE_TAX_RATE_ID missing)');
  const c = await loadContract(contract);
  const b = c.billing || {};
  // Checked before the generic guard so a live subscription gets the specific code.
  if (b.subscriptionId && LIVE_BILLING_STATUSES.includes(b.status)) {
    throw contractError('already_subscribed', 'Monthly payments are already set up for this agreement');
  }
  assertCan('checkout', c); // invalid_state | package_missing
  if (!isValidPackage(c.package)) throw contractError('package_missing', 'The monitoring package must be set before payment');
  const linked = portalUser && (portalUser.contracts || []).some((id) => idStr(id) === String(c._id));
  if (!linked) throw contractError('no_portal_user', 'This account is not linked to the agreement');

  // Reuse the open session (two tabs, a back button) instead of minting another.
  if (b.status === 'checkout_open' && b.checkoutSessionId && b.checkoutExpiresAt &&
      new Date(b.checkoutExpiresAt).getTime() - Date.now() > SESSION_REUSE_MARGIN_MS) {
    const existing = await s.checkout.sessions.retrieve(b.checkoutSessionId).catch(() => null);
    if (existing && existing.status === 'open' && existing.url) {
      return { url: existing.url, sessionId: existing.id, reused: true };
    }
    if (existing && existing.status === 'complete') {
      // Paid but the webhook hasn't landed yet: link it now and refuse a second one.
      await linkCompletedSession(s, c, existing, { actor: 'homeowner' });
      throw contractError('already_subscribed', 'Monthly payments are already set up for this agreement');
    }
  }

  const { prices, taxRateId } = await assertCatalog();
  const customerId = await ensureCustomer(s, c);
  const nowMs = Date.now();
  const params = buildCheckoutSessionParams({ contract: c, customerId, priceId: prices[c.package], taxRateId, nowMs });
  // Same minute + same params → Stripe returns the same session (double click).
  const session = await s.checkout.sessions.create(params, {
    idempotencyKey: `checkout-${c._id}-${Math.floor(nowMs / 60000)}`,
  });
  const expiresAt = new Date(session.expires_at * 1000);
  await AlarmContract.updateOne(
    { _id: c._id, 'billing.status': { $in: ['none', 'checkout_open'] } },
    { $set: { 'billing.status': 'checkout_open', 'billing.checkoutSessionId': session.id, 'billing.checkoutExpiresAt': expiresAt } }
  );
  await afterBillingWrite(c._id, { actor: 'homeowner', actorName: portalUser.email || '' });
  await logContractEvent({
    contract: c,
    type: 'checkout_started',
    actor: 'homeowner',
    actorName: portalUser.email || '',
    message: `Checkout opened for ${PACKAGES[c.package].label}`,
    meta: { sessionId: session.id },
  });
  return { url: session.url, sessionId: session.id, reused: false };
}

// The Billing Portal configuration every session is pinned to. Relying on the
// account's DEFAULT configuration would make "homeowners can't cancel or
// switch plans" a dashboard checkbox someone can untick; this one is created
// by code with cancel and plan switching off, found again by its metadata
// marker, and cached per process (per Stripe key).
const PORTAL_CONFIG_MARKER = 'genius_alarm_portal_v1';
let portalConfigCache = { key: '', id: '' };

async function lockedPortalConfigurationId(s) {
  const key = env.stripe.secretKey || '';
  if (portalConfigCache.id && portalConfigCache.key === key) return portalConfigCache.id;
  let id = '';
  const existing = await s.billingPortal.configurations.list({ active: true, limit: 100 });
  for (const cfg of (existing && existing.data) || []) {
    const f = cfg.features || {};
    const locked = cfg.metadata && cfg.metadata.app === PORTAL_CONFIG_MARKER
      && !(f.subscription_cancel && f.subscription_cancel.enabled)
      && !(f.subscription_update && f.subscription_update.enabled);
    if (locked) {
      id = cfg.id;
      break;
    }
  }
  if (!id) {
    const cfg = await s.billingPortal.configurations.create({
      name: 'Genius alarm monitoring (card updates only)',
      metadata: { app: PORTAL_CONFIG_MARKER },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: { enabled: false },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
    });
    id = cfg.id;
  }
  portalConfigCache = { key, id };
  return id;
}

/**
 * Stripe Billing Portal session (update card, view invoices). Always pinned to
 * the code-defined configuration above, never the account default.
 * @param {object} contract
 * @param {{returnUrl?: string}} [opts] default `${appUrl}/portal`
 * @returns {Promise<{url: string}>}
 * @throws not_configured | no_customer
 */
async function createBillingPortalSession(contract, { returnUrl } = {}) {
  const s = requireStripe();
  const c = await loadContract(contract);
  if (!c.billing || !c.billing.customerId) throw contractError('no_customer', 'Payment has not been set up for this agreement yet');
  const configuration = await lockedPortalConfigurationId(s);
  const session = await s.billingPortal.sessions.create({
    customer: c.billing.customerId,
    configuration,
    return_url: returnUrl || `${env.appUrl}/portal`,
  });
  return { url: session.url };
}

/**
 * Staff close a signed contract whose payment was never set up (no Stripe
 * subscription): expire an open Checkout session so it can't complete
 * afterwards, then mark billing canceled. No homeowner email: nothing was
 * ever billed. Works without Stripe configured when no session is open.
 * @param {object} contract
 * @param {{reason?: string, user?: string}} [opts]
 * @returns {Promise<object>} updated contract (lean)
 * @throws invalid_state (a subscription exists / payment just completed) | not_configured
 */
async function cancelWithoutSubscription(contract, { reason = '', user = '' } = {}) {
  const c = await loadContract(contract);
  assertCan('cancel', c);
  if (c.billing && c.billing.subscriptionId) throw contractError('invalid_state', 'This contract has a Stripe subscription; cancel it instead');
  const sessionId = c.billing && c.billing.status === 'checkout_open' ? c.billing.checkoutSessionId : '';
  if (sessionId) {
    const s = requireStripe();
    try {
      await s.checkout.sessions.expire(sessionId);
    } catch (err) {
      // Already expired is fine; already COMPLETE means the homeowner just
      // paid and the webhook is on its way, so don't close it under them.
      const session = await s.checkout.sessions.retrieve(sessionId).catch(() => null);
      if (session && session.status === 'complete') {
        throw contractError('invalid_state', 'The homeowner just completed payment. Sync with Stripe, then cancel the subscription if needed.');
      }
      if (!session || session.status !== 'expired') throw err;
    }
  }
  const comment = String(reason || '').slice(0, 500);
  const now = new Date();
  const r = await AlarmContract.updateOne(
    { _id: c._id, 'billing.subscriptionId': { $in: [null, ''] } },
    {
      $set: {
        'billing.status': 'canceled',
        'billing.canceledAt': now,
        'billing.endedAt': now,
        'billing.checkoutExpiresAt': null,
        canceledBy: user || '',
        cancelReason: comment,
      },
    }
  );
  if (!r.matchedCount) throw contractError('invalid_state', 'Payment was just set up for this contract; reload and try again');
  await afterBillingWrite(c._id, { actor: 'user', actorName: user, notify: false });
  return AlarmContract.findById(c._id).lean();
}

/**
 * Staff cancel. atPeriodEnd (default) sets cancel_at_period_end; otherwise
 * cancels now. Syncs the subscription immediately, logs 'canceled', sends the
 * 'canceled' email (when it actually ends).
 * @param {object} contract
 * @param {{atPeriodEnd?: boolean, reason?: string, user?: string}} [opts]
 * @returns {Promise<object>} updated contract (lean)
 * @throws not_configured | invalid_state
 */
async function cancelSubscription(contract, { atPeriodEnd = true, reason = '', user = '' } = {}) {
  const s = requireStripe();
  const c = await loadContract(contract);
  assertCan('cancel', c);
  const subId = c.billing && c.billing.subscriptionId;
  if (!subId) throw contractError('invalid_state', 'This contract has no Stripe subscription to cancel');
  const comment = String(reason || '').slice(0, 500);
  // Recorded first so the status-change log / email below can quote it.
  await AlarmContract.updateOne({ _id: c._id }, { $set: { canceledBy: user || '', cancelReason: comment } });
  const details = comment ? { cancellation_details: { comment } } : {};
  if (atPeriodEnd) {
    await s.subscriptions.update(subId, { cancel_at_period_end: true, ...details });
  } else {
    await s.subscriptions.cancel(subId, { prorate: false, invoice_now: false, ...details });
  }
  const sub = await retrieveSubscription(s, subId);
  const fresh = await loadContract(c._id);
  await syncSubscription(fresh, sub, { actor: 'user', actorName: user });
  if (atPeriodEnd) {
    const ends = getPeriodEnd(sub);
    await logContractEvent({
      contract: c,
      type: 'admin_action',
      actor: 'user',
      actorName: user,
      message: `Cancellation scheduled for the end of the period${ends ? ` (${ends.toISOString().slice(0, 10)})` : ''}${comment ? `: ${comment}` : ''}`,
    });
  }
  return AlarmContract.findById(c._id).lean();
}

// ---------------------------------------------------------------------------
// Checkout completion + the double-subscription guard
// ---------------------------------------------------------------------------

// Refund every paid payment of one invoice. Basil removed invoice.charge /
// invoice.payment_intent, so the PaymentIntent comes from invoicePayments.
async function refundInvoice(s, invoiceId, { contractId = '' } = {}) {
  const list = await s.invoicePayments.list({ invoice: invoiceId, limit: 10 });
  const refunded = [];
  for (const ip of list.data || []) {
    const pay = ip.payment || {};
    const pi = pay.type === 'payment_intent' ? idOf(pay.payment_intent) : null;
    if (!pi || ip.status !== 'paid') continue;
    try {
      await s.refunds.create(
        { payment_intent: pi, reason: 'duplicate', metadata: { contractId: String(contractId), invoiceId } },
        { idempotencyKey: `dup-refund-${pi}` }
      );
      refunded.push(pi);
    } catch (err) {
      if (err && err.code === 'charge_already_refunded') continue;
      throw err;
    }
  }
  return refunded;
}

// A second subscription reached the contract (two Checkouts completed, or a
// stale session paid after staff cancelled): cancel it now, refund what it
// charged, tell staff. The contract keeps its original subscription.
async function handleDuplicateSubscription(s, c, session, subId) {
  const sub = await s.subscriptions.retrieve(subId).catch(() => null);
  if (sub && !['canceled', 'incomplete_expired'].includes(sub.status)) {
    await s.subscriptions.cancel(subId, { prorate: false, invoice_now: false });
  }
  const invoiceIds = new Set();
  if (session.invoice) invoiceIds.add(idOf(session.invoice));
  const invs = await s.invoices.list({ subscription: subId, limit: 10 });
  for (const inv of invs.data || []) if (inv.status === 'paid') invoiceIds.add(inv.id);
  const refunded = [];
  for (const invoiceId of invoiceIds) refunded.push(...(await refundInvoice(s, invoiceId, { contractId: c._id })));
  await logContractEvent({
    contract: c,
    type: 'alert',
    actor: 'stripe',
    message: `Duplicate subscription ${subId} cancelled${refunded.length ? ` and ${refunded.length} payment(s) refunded` : ''}; the contract keeps ${c.billing.subscriptionId}`,
    meta: { duplicateSubscriptionId: subId, sessionId: session.id, refunded },
  });
  await emails().sendAdminAlert({
    contract: c,
    alertKind: 'double_subscription',
    title: `Duplicate monitoring subscription cancelled (${c.number})`,
    lines: [
      `A second Stripe Checkout completed for ${c.number}.`,
      `The new subscription ${subId} was cancelled immediately${refunded.length ? ' and its payment refunded' : ''}.`,
      `The contract keeps subscription ${c.billing.subscriptionId}. Check the Stripe dashboard if anything looks off.`,
    ],
  });
  return { handled: true, contractId: String(c._id), duplicate: true };
}

// Link a completed subscription-mode Checkout Session to its contract (webhook
// or reconcile). Compare-and-set on an empty subscriptionId; if another
// subscription is already linked, that's the double-subscription guard.
async function linkCompletedSession(s, c, session, { actor = 'stripe' } = {}) {
  const subId = idOf(session.subscription);
  if (!subId) return { ignored: 'no_subscription' };
  const customerId = idOf(session.customer);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = attempt === 0 ? c : await loadContract(c._id);
    const linked = current.billing && current.billing.subscriptionId;
    if (linked && linked !== subId) return handleDuplicateSubscription(s, current, session, subId);
    const $set = { 'billing.subscriptionId': subId, 'billing.checkoutExpiresAt': null };
    if (customerId && !current.billing.customerId) $set['billing.customerId'] = customerId;
    const r = await AlarmContract.updateOne({ _id: c._id, 'billing.subscriptionId': { $in: [null, subId] } }, { $set });
    if (!r.matchedCount) continue; // lost a race; re-read and decide again
    const isNew = !linked;
    const sub = await retrieveSubscription(s, subId);
    await syncSubscription(await loadContract(c._id), sub, { actor });
    if (isNew) {
      await logContractEvent({
        contract: c,
        type: 'checkout_completed',
        actor,
        message: 'Payment set up through Stripe Checkout',
        meta: { sessionId: session.id, subscriptionId: subId },
      });
    }
    // The first invoice may have been paid before the link existed.
    if (session.invoice) await applyInvoice(s, idOf(session.invoice), { actor, eventType: 'invoice.paid', contract: await loadContract(c._id) });
    return { handled: true, contractId: String(c._id), linked: isNew };
  }
  return { ignored: 'link_conflict' };
}

// ---------------------------------------------------------------------------
// Invoices → ContractPayment
// ---------------------------------------------------------------------------

function contractIdFromInvoice(inv) {
  const details = (inv.parent && inv.parent.subscription_details) || inv.subscription_details || {};
  return (details.metadata && details.metadata.contractId) || (inv.metadata && inv.metadata.contractId) || null;
}

// Best-effort decline reason for a failed invoice ("Your card was declined.").
async function invoiceFailureMessage(s, inv) {
  try {
    let pi = null;
    if (inv.payment_intent) {
      pi = typeof inv.payment_intent === 'object' ? inv.payment_intent : await s.paymentIntents.retrieve(inv.payment_intent);
    } else {
      const list = await s.invoicePayments.list({ invoice: inv.id, limit: 10, expand: ['data.payment.payment_intent'] });
      const withPi = (list.data || [])
        .filter((ip) => ip.payment && ip.payment.payment_intent && typeof ip.payment.payment_intent === 'object')
        .sort((a, b) => (b.created || 0) - (a.created || 0));
      pi = withPi.length ? withPi[0].payment.payment_intent : null;
    }
    const e = pi && pi.last_payment_error;
    return (e && (e.message || e.decline_code || e.code)) || '';
  } catch {
    return '';
  }
}

// Upsert one invoice. Returns { payment, prev } (prev = the row before, null
// when created). The webhook and the reconciler both come through here, so a
// replay converges on the same row.
//
// Stale-read guard (see READ_AT): the write only applies when the stored row
// was read no later than this invoice was. A newer row makes the filtered
// upsert try an insert, which the unique stripeInvoiceId index refuses; a
// second refusal therefore means "stale", and the row is left as it is.
async function upsertPayment(s, c, inv) {
  const fields = paymentFromInvoice(inv);
  fields.contract = c._id;
  fields.amountMismatch = isAmountMismatch(fields, c);
  if (!fields.failureMessage && fields.status === 'open' && fields.attemptCount > 0) {
    fields.failureMessage = await invoiceFailureMessage(s, inv);
  }
  const readAt = readAtOf(inv);
  if (readAt) fields.stripeReadAt = readAt;
  const filter = readAt ? { stripeInvoiceId: inv.id, ...notNewerThan('stripeReadAt', readAt) } : { stripeInvoiceId: inv.id };
  const run = () =>
    ContractPayment.findOneAndUpdate(filter, { $set: fields }, { upsert: true, new: false, setDefaultsOnInsert: true }).lean();
  let prev;
  let stale = false;
  try {
    prev = await run();
  } catch (err) {
    if (err.code !== 11000) throw err;
    try {
      prev = await run(); // two upserts raced on insert; the second is an update now
    } catch (err2) {
      if (err2.code !== 11000 || !readAt) throw err2;
      stale = true; // a newer read already wrote this row
    }
  }
  const payment = await ContractPayment.findOne({ stripeInvoiceId: inv.id }).lean();
  // prev === payment for a stale read: nothing changed, nothing to log.
  return { payment, prev: stale ? payment : prev, stale };
}

// History lines for a payment row change (shared by webhook + reconcile).
async function logPaymentChange(c, payment, prev, { actor }) {
  let becamePaid = payment.status === 'paid' && payment.amountPaidCents > 0 && (!prev || prev.status !== 'paid');
  let newFailure = payment.status !== 'paid' && payment.attemptCount > 0 && payment.attempted &&
    (!prev || (prev.attemptCount || 0) < payment.attemptCount);
  // A row rebuilt from scratch (deleted rows re-synced by the reconciler)
  // looks "new", but its history lines were already written the first time.
  if (!prev && becamePaid) {
    becamePaid = !(await ContractEvent.exists({ contract: c._id, type: 'payment_succeeded', 'meta.invoiceId': payment.stripeInvoiceId }));
  }
  if (!prev && newFailure) {
    newFailure = !(await ContractEvent.exists({
      contract: c._id,
      type: 'payment_failed',
      'meta.invoiceId': payment.stripeInvoiceId,
      'meta.attemptCount': payment.attemptCount,
    }));
  }
  const label = payment.number ? `invoice ${payment.number}` : payment.stripeInvoiceId;
  if (becamePaid) {
    await logContractEvent({
      contract: c,
      type: 'payment_succeeded',
      actor,
      message: `Payment of ${fmtCad(payment.amountPaidCents)} received (${label})`,
      meta: { invoiceId: payment.stripeInvoiceId },
    });
  }
  if (newFailure) {
    await logContractEvent({
      contract: c,
      type: 'payment_failed',
      actor,
      message: `Payment of ${fmtCad(payment.amountDueCents || payment.totalCents)} failed (${label}, attempt ${payment.attemptCount})${payment.failureMessage ? `: ${payment.failureMessage}` : ''}`,
      meta: { invoiceId: payment.stripeInvoiceId, attemptCount: payment.attemptCount },
    });
  }
  if (payment.amountMismatch && (!prev || !prev.amountMismatch)) {
    await logContractEvent({
      contract: c,
      type: 'alert',
      actor,
      message: `${label} total ${fmtCad(payment.totalCents)} differs from the contract price ${fmtCad(c.pricing && c.pricing.totalCents)}`,
      meta: { invoiceId: payment.stripeInvoiceId },
    });
  }
  return { becamePaid, newFailure };
}

// invoice.* handler body (also used after linking a Checkout).
async function applyInvoice(s, invoiceId, { actor = 'stripe', eventType = '', contract = null } = {}) {
  const readAt = new Date();
  const inv = stampRead(await s.invoices.retrieve(invoiceId), readAt);
  const subId = getSubscriptionId(inv);
  let c =
    contract ||
    (await findContract({ subscriptionId: subId, contractId: contractIdFromInvoice(inv), customerId: idOf(inv.customer) }));
  if (!c) return { ignored: 'unknown_contract' };
  // Only the contract's own subscription bills it. A second subscription (two
  // Checkout tabs paid) still carries our contractId metadata and the same
  // customer, but it is cancelled + refunded by handleDuplicateSubscription:
  // its invoices must not become payment rows, receipts or history. Nothing
  // linked yet (the invoice beat checkout.session.completed): adopt the
  // subscription through syncSubscription's compare-and-set first, so exactly
  // one subscription wins, then check again.
  if (subId) {
    if (!(c.billing && c.billing.subscriptionId)) {
      await syncSubscription(c, await retrieveSubscription(s, subId), { actor });
      c = await loadContract(c._id);
    }
    if (c.billing.subscriptionId && c.billing.subscriptionId !== subId) return { ignored: 'other_subscription' };
  }
  const { payment, prev } = await upsertPayment(s, c, inv);
  const change = await logPaymentChange(c, payment, prev, { actor });
  await recomputeBillingAggregates(c._id);
  // The subscription status moves with the invoice (incomplete → active,
  // active ⇄ past_due); re-sync it so ordering of the two events doesn't matter.
  if (subId && c.billing.subscriptionId === subId && (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed')) {
    await syncSubscription(await loadContract(c._id), await retrieveSubscription(s, subId), { actor });
  }
  if (eventType === 'invoice.paid' && payment.status === 'paid' && payment.amountPaidCents > 0) {
    await sendReceiptForPayment(payment._id, { actor });
  }
  if (eventType === 'invoice.payment_failed' && payment.status === 'open') {
    await sendFailureForPayment(payment._id, { actor });
    if (change.newFailure && payment.attemptCount === 1) await alertPaymentFailed(c, payment);
  }
  return { handled: true, contractId: String(c._id) };
}

async function alertPaymentFailed(c, payment) {
  await emails().sendAdminAlert({
    contract: c,
    alertKind: 'payment_failed',
    title: `Monitoring payment failed (${c.number})`,
    lines: [
      `${fmtCad(payment.amountDueCents || payment.totalCents)} could not be charged${payment.number ? ` (invoice ${payment.number})` : ''}.`,
      payment.failureMessage ? `Reason: ${payment.failureMessage}` : '',
      payment.nextPaymentAttempt ? `Stripe retries automatically on ${new Date(payment.nextPaymentAttempt).toISOString().slice(0, 10)}.` : 'No automatic retry is scheduled.',
    ].filter(Boolean),
  });
}

// PaymentIntent → invoice id. Basil removed charge.invoice; invoicePayments
// can be filtered by the payment instead.
async function invoiceIdForPaymentIntent(s, paymentIntentId) {
  const list = await s.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 });
  const ip = list.data && list.data[0];
  return ip ? idOf(ip.invoice) : null;
}

// Copy a charge's refunded amount onto its ContractPayment. Returns
// { ignored } or { handled, contractId, changed }.
async function applyChargeRefund(s, charge, { actor = 'stripe' } = {}) {
  const pi = idOf(charge.payment_intent);
  const invoiceId = (pi && (await invoiceIdForPaymentIntent(s, pi))) || idOf(charge.invoice); // legacy shape fallback
  if (!invoiceId) return { ignored: 'no_invoice' };
  let row = await ContractPayment.findOne({ stripeInvoiceId: invoiceId }).lean();
  if (!row) {
    const r = await applyInvoice(s, invoiceId, { actor });
    if (r.ignored) return r;
    row = await ContractPayment.findOne({ stripeInvoiceId: invoiceId }).lean();
    if (!row) return { ignored: 'unknown_contract' };
  }
  const refunded = Number(charge.amount_refunded) || 0;
  if ((row.amountRefundedCents || 0) === refunded) return { handled: true, contractId: String(row.contract), changed: false };
  await ContractPayment.updateOne({ _id: row._id }, { $set: { amountRefundedCents: refunded } });
  await recomputeBillingAggregates(row.contract);
  await logContractEvent({
    contract: row.contract,
    type: 'payment_refunded',
    actor,
    message: `${fmtCad(refunded)} refunded${row.number ? ` on invoice ${row.number}` : ''}`,
    meta: { invoiceId, paymentIntent: pi },
  });
  return { handled: true, contractId: String(row.contract), changed: true };
}

// ---------------------------------------------------------------------------
// Webhook entry point
// ---------------------------------------------------------------------------

const INVOICE_EVENTS = new Set([
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
]);
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.expired',
  ...SUBSCRIPTION_EVENTS,
  ...INVOICE_EVENTS,
  'charge.refunded',
]);

/**
 * Apply one verified Stripe event (called by routes/webhooks.js inside the
 * WebhookEvent claim, and by the reconciler on retries). Handles
 * checkout.session.completed (+ double-subscription guard),
 * checkout.session.expired, customer.subscription.created|updated|deleted,
 * invoice.finalized|paid|payment_failed|voided|marked_uncollectible,
 * charge.refunded. Anything else → { ignored: 'unhandled_type' }. Events for
 * objects with no matching contract → { ignored: 'unknown_contract' }.
 * Throws on transient failures so the webhook answers 500 and Stripe retries.
 * @param {import('stripe').Stripe.Event} event
 * @returns {Promise<{handled?: boolean, contractId?: string, ignored?: string}>}
 */
async function applyStripeEvent(event) {
  const type = event && event.type;
  if (!HANDLED_EVENTS.has(type)) return { ignored: 'unhandled_type' };
  const s = requireStripe();
  const obj = (event.data && event.data.object) || {};
  if (!obj.id) return { ignored: 'no_object' };

  if (type === 'checkout.session.completed' || type === 'checkout.session.expired') {
    const session = await s.checkout.sessions.retrieve(obj.id);
    if (session.mode !== 'subscription') return { ignored: 'not_subscription' };
    const c = await findContract({
      contractId: session.client_reference_id || (session.metadata && session.metadata.contractId),
      customerId: idOf(session.customer),
    });
    if (!c) return { ignored: 'unknown_contract' };
    if (type === 'checkout.session.expired') return expireSession(c, session, { actor: 'stripe' });
    if (session.status !== 'complete') return { ignored: 'not_complete' };
    return linkCompletedSession(s, c, session, { actor: 'stripe' });
  }

  if (SUBSCRIPTION_EVENTS.has(type)) {
    const sub = await retrieveSubscription(s, obj.id);
    const c = await findContract({
      subscriptionId: sub.id,
      contractId: sub.metadata && sub.metadata.contractId,
    });
    if (!c) return { ignored: 'unknown_contract' };
    const r = await syncSubscription(c, sub, { actor: 'stripe' });
    if (r.skipped) return { ignored: r.skipped };
    return { handled: true, contractId: String(c._id) };
  }

  if (INVOICE_EVENTS.has(type)) return applyInvoice(s, obj.id, { actor: 'stripe', eventType: type });

  // charge.refunded
  const charge = await s.charges.retrieve(obj.id);
  return applyChargeRefund(s, charge, { actor: 'stripe' });
}

// checkout.session.expired (or the reconciler finding one): back to 'none',
// compare-and-set on this session so a newer session is never cleared.
async function expireSession(c, session, { actor = 'stripe' } = {}) {
  const r = await AlarmContract.updateOne(
    { _id: c._id, 'billing.checkoutSessionId': session.id, 'billing.status': 'checkout_open' },
    { $set: { 'billing.status': 'none', 'billing.checkoutSessionId': '', 'billing.checkoutExpiresAt': null } }
  );
  if (!r.modifiedCount) return { handled: true, contractId: String(c._id), changed: false };
  await afterBillingWrite(c._id, { actor });
  await logContractEvent({ contract: c, type: 'checkout_expired', actor, message: 'Checkout expired without payment', meta: { sessionId: session.id } });
  return { handled: true, contractId: String(c._id), changed: true };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Re-sync one contract from Stripe: subscription (status, period, card),
 * every invoice (auto-pagination) → ContractPayment upserts, link a completed
 * Checkout whose webhook never arrived, recompute aggregates. Each correction
 * logs a 'reconcile_fix' ContractEvent.
 * @param {object|string} contractOrId
 * @param {{actor?: 'stripe_reconciler'|'user'|'homeowner'|'system'}} [opts]
 * @returns {Promise<{fixes: number, payments: number, status: string}>}
 */
async function reconcileContract(contractOrId, { actor = 'stripe_reconciler' } = {}) {
  const s = requireStripe();
  let c = await loadContract(contractOrId);
  let fixes = 0;
  const fix = async (message, meta) => {
    fixes += 1;
    await logContractEvent({ contract: c, type: 'reconcile_fix', actor, message, meta });
  };

  // 1. Checkout sessions whose webhook never arrived.
  if (!c.billing.subscriptionId) {
    const sessions = [];
    if (c.billing.checkoutSessionId) {
      const one = await s.checkout.sessions.retrieve(c.billing.checkoutSessionId).catch(() => null);
      if (one) sessions.push(one);
    }
    if (c.billing.customerId) {
      const list = await s.checkout.sessions.list({ customer: c.billing.customerId, limit: 20 });
      for (const x of list.data || []) if (!sessions.some((y) => y.id === x.id)) sessions.push(x);
    }
    const mine = (x) => x.mode === 'subscription' && (!x.client_reference_id || x.client_reference_id === String(c._id));
    const complete = sessions.find((x) => mine(x) && x.status === 'complete' && x.subscription);
    if (complete) {
      const r = await linkCompletedSession(s, c, complete, { actor });
      if (r.handled) await fix(`Linked completed Checkout ${complete.id} (webhook missed)`, { sessionId: complete.id });
    } else if (c.billing.status === 'checkout_open' && c.billing.checkoutSessionId) {
      const open = sessions.find((x) => x.id === c.billing.checkoutSessionId);
      const pastExpiry = c.billing.checkoutExpiresAt && new Date(c.billing.checkoutExpiresAt).getTime() < Date.now();
      if ((open && open.status === 'expired') || (!open && pastExpiry)) {
        const r = await expireSession(c, { id: c.billing.checkoutSessionId }, { actor });
        if (r.changed) await fix('Cleared an expired Checkout session');
      }
    }
    c = await loadContract(c._id);
  }

  // 2. Subscription mirror.
  if (c.billing.subscriptionId) {
    const sub = await retrieveSubscription(s, c.billing.subscriptionId);
    const r = await syncSubscription(c, sub, { actor });
    if (r.changed && r.changed.length) await fix(`Subscription mirror corrected (${r.changed.join(', ')})`, { fields: r.changed });
    c = await loadContract(c._id);
  }

  // 3. Every invoice of the customer → ContractPayment.
  let payments = 0;
  if (c.billing.customerId) {
    let created = 0;
    let updated = 0;
    const now = Date.now();
    // Every invoice is stamped with the time the listing started: later pages
    // are at least that fresh, and a webhook read after it wins (READ_AT).
    const listedAt = new Date();
    for await (const raw of s.invoices.list({ customer: c.billing.customerId, limit: 100 })) {
      const inv = stampRead(raw, listedAt);
      if (inv.status === 'draft') continue; // not final yet; invoice.finalized brings it in
      // Invoices of any other subscription on this customer (a cancelled
      // duplicate) are not this contract's payments; see applyInvoice.
      const invSub = getSubscriptionId(inv);
      if (invSub && invSub !== c.billing.subscriptionId) continue;
      payments += 1;
      const { payment, prev } = await upsertPayment(s, c, inv);
      if (!prev) created += 1;
      else if (paymentDiffers(prev, payment)) updated += 1;
      else continue;
      const change = await logPaymentChange(c, payment, prev, { actor });
      // A webhook we never got: send the email it would have sent, if recent.
      if (change.becamePaid && payment.paidAt && now - new Date(payment.paidAt).getTime() < RECONCILE_EMAIL_WINDOW_MS) {
        await sendReceiptForPayment(payment._id, { actor });
      }
      // A failure notice is still useful while Stripe is retrying (the claim
      // keeps it to one per invoice); older open invoices are left alone.
      if (change.newFailure && payment.status === 'open' &&
          (!payment.invoiceCreatedAt || now - new Date(payment.invoiceCreatedAt).getTime() < FAILURE_EMAIL_MAX_AGE_MS)) {
        await sendFailureForPayment(payment._id, { actor });
      }
    }
    if (created || updated) await fix(`Payments re-synced from Stripe (${created} added, ${updated} updated)`, { created, updated });

    // 4. Refunds. Only refunded charges need the invoice lookup.
    let refundFixes = 0;
    for await (const ch of s.charges.list({ customer: c.billing.customerId, limit: 100 })) {
      if (!(ch.amount_refunded > 0)) continue;
      const r = await applyChargeRefund(s, ch, { actor });
      if (r.changed) refundFixes += 1;
    }
    if (refundFixes) await fix(`Refunds re-synced from Stripe (${refundFixes})`);
  }

  await recomputeBillingAggregates(c._id);
  await AlarmContract.updateOne({ _id: c._id }, { $set: { 'billing.lastReconciledAt': new Date() } });
  await afterBillingWrite(c._id, { actor });
  const final = await AlarmContract.findById(c._id).select('status').lean();
  return { fixes, payments, status: final ? final.status : c.status };
}

function paymentDiffers(a, b) {
  const keys = ['status', 'attemptCount', 'amountPaidCents', 'amountRemainingCents', 'totalCents', 'number', 'missed', 'amountMismatch'];
  if (keys.some((k) => (a[k] ?? null) !== (b[k] ?? null))) return true;
  return !sameTime(a.paidAt, b.paidAt) || !sameTime(a.periodEnd, b.periodEnd);
}

/**
 * Recompute billing.{firstPaidAt,lastPaidAt,paidCount,totalPaidCents,
 * totalTaxCents,failedCount,missedCount,missedOpenCents,consecutiveMissed,
 * lastFailureAt,lastFailureMessage} from ContractPayment and $set them.
 * @param {string} contractId
 * @returns {Promise<object>} the aggregates written
 */
async function recomputeBillingAggregates(contractId) {
  const readAggregates = async () => {
    const rows = await ContractPayment.find({ contract: contractId })
      .select('status attempted attemptCount amountPaidCents amountRefundedCents amountRemainingCents amountDueCents totalCents taxCents paidAt periodStart periodEnd invoiceCreatedAt failureMessage updatedAt missed')
      .lean();
    return { rows, agg: computeAggregates(rows) };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let { rows, agg } = await readAggregates();
  // Keep the stored per-row flag honest too (isMissed may have been refined).
  const fixMissed = rows.filter((r) => Boolean(r.missed) !== isMissed(r));
  for (const r of fixMissed) await ContractPayment.updateOne({ _id: r._id }, { $set: { missed: isMissed(r) } });
  // Two recomputes can interleave (webhook + reconciler): one reads the rows
  // before the other's payment write and then writes last. So after writing,
  // read again; if the rows moved meanwhile, write the newer answer. The last
  // writer always re-checks after its own write, so the stored value settles
  // on the current rows.
  for (let i = 0; i < 3; i += 1) {
    const $set = {};
    for (const [k, v] of Object.entries(agg)) $set[`billing.${k}`] = v;
    await AlarmContract.updateOne({ _id: contractId }, { $set });
    const again = (await readAggregates()).agg;
    if (same(again, agg)) break;
    agg = again;
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Receipt / failure emails behind the ContractPayment claims
// ---------------------------------------------------------------------------

// Claim → send → sentAt. A failed send releases the claim (claimedAt null +
// error) for the reconciler to retry (≤ MAX_EMAIL_ATTEMPTS). A send the gates
// skipped ('disabled' / 'no_recipient') keeps its claim with error
// 'skipped:<reason>' and is final — only force (admin button) re-sends it.
async function sendWithClaim(paymentId, field, kind, { force = false, actor = 'system', user = '', data }) {
  const now = new Date();
  const stale = new Date(now.getTime() - EMAIL_CLAIM_STALE_MS);
  const f = (k) => `${field}.${k}`;
  const filter = force
    ? {
        _id: paymentId,
        $or: [{ [f('claimedAt')]: null }, { [f('claimedAt')]: { $lt: stale } }, { [f('sentAt')]: { $ne: null } }, { [f('error')]: { $nin: ['', null] } }],
      }
    : {
        _id: paymentId,
        [f('sentAt')]: null,
        [f('attempts')]: { $not: { $gte: MAX_EMAIL_ATTEMPTS } },
        $or: [{ [f('claimedAt')]: null }, { [f('claimedAt')]: { $lt: stale }, [f('error')]: { $in: ['', null] } }],
      };
  const claimed = await ContractPayment.findOneAndUpdate(
    filter,
    { $set: { [f('claimedAt')]: now, [f('error')]: '' }, $inc: { [f('attempts')]: 1 } },
    { new: true }
  ).lean();
  if (!claimed) {
    const row = await ContractPayment.findById(paymentId).select(field).lean();
    if (!row) return { ok: false, error: 'not_found' };
    const claim = row[field] || {};
    return { ok: false, skipped: claim.sentAt ? 'already_sent' : String(claim.error || '').startsWith('skipped:') ? claim.error.slice(8) : 'claimed' };
  }
  const contract = await AlarmContract.findById(claimed.contract).lean();
  if (!contract) {
    await ContractPayment.updateOne({ _id: paymentId }, { $set: { [f('error')]: 'skipped:no_contract' } });
    return { ok: false, skipped: 'no_contract' };
  }
  let r;
  try {
    r = await emails().sendContractEmail({ contract, kind, data: data(claimed), force, actor, actorName: user });
  } catch (err) {
    r = { ok: false, error: err.message }; // sendContractEmail shouldn't throw; belt and braces
  }
  if (r.ok) {
    await ContractPayment.updateOne({ _id: paymentId }, { $set: { [f('sentAt')]: new Date(), [f('error')]: '' } });
  } else if (r.skipped === 'disabled' || r.skipped === 'no_recipient') {
    await ContractPayment.updateOne({ _id: paymentId }, { $set: { [f('error')]: `skipped:${r.skipped}` } });
  } else {
    await ContractPayment.updateOne(
      { _id: paymentId },
      { $set: { [f('claimedAt')]: null, [f('error')]: String(r.error || r.skipped || 'send_failed').slice(0, 300) } }
    );
  }
  return { ok: Boolean(r.ok), ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.error ? { error: r.error } : {}) };
}

/**
 * Send (or re-send) the receipt email for one ContractPayment through its
 * receiptEmail claim. force:true (admin "Email receipt") ignores the toggles
 * and an earlier sentAt.
 * @param {string} paymentId
 * @param {{force?: boolean, actor?: string, user?: string}} [opts]
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
async function sendReceiptForPayment(paymentId, { force = false, actor = 'system', user = '' } = {}) {
  const row = await ContractPayment.findById(paymentId).select('status').lean();
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'paid') return { ok: false, skipped: 'not_paid' };
  return sendWithClaim(paymentId, 'receiptEmail', 'receipt', { force, actor, user, data: (payment) => ({ payment }) });
}

/** Failed-payment email for one ContractPayment (failureEmail claim, once per invoice). */
async function sendFailureForPayment(paymentId, { force = false, actor = 'system', user = '' } = {}) {
  const row = await ContractPayment.findById(paymentId).select('status').lean();
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'open') return { ok: false, skipped: 'not_open' };
  return sendWithClaim(paymentId, 'failureEmail', 'payment_failed', {
    force,
    actor,
    user,
    data: (payment) => ({ payment, failureMessage: payment.failureMessage || '', nextAttemptAt: payment.nextPaymentAttempt || null }),
  });
}

// Reconciler: email claims that failed (or crashed) and still have attempts left.
async function retryPendingEmails({ limit = 50, now = new Date(), actor = 'stripe_reconciler' } = {}) {
  const stale = new Date(now.getTime() - EMAIL_CLAIM_STALE_MS);
  const pending = (field, status) => ({
    status,
    [`${field}.sentAt`]: null,
    [`${field}.attempts`]: { $gt: 0, $lt: MAX_EMAIL_ATTEMPTS },
    $or: [{ [`${field}.claimedAt`]: null }, { [`${field}.claimedAt`]: { $lt: stale }, [`${field}.error`]: { $in: ['', null] } }],
  });
  let retried = 0;
  const receipts = await ContractPayment.find(pending('receiptEmail', 'paid')).select('_id').limit(limit).lean();
  for (const r of receipts) {
    await sendReceiptForPayment(r._id, { actor });
    retried += 1;
  }
  const failures = await ContractPayment.find(pending('failureEmail', 'open')).select('_id').limit(limit).lean();
  for (const r of failures) {
    await sendFailureForPayment(r._id, { actor });
    retried += 1;
  }
  return retried;
}

// ---------------------------------------------------------------------------
// Pure helpers (Stripe track)
// ---------------------------------------------------------------------------

/** success / cancel URLs for a contract's Checkout (pure). */
function checkoutUrls(contractId) {
  const base = `${env.appUrl}/portal/pay?contract=${encodeURIComponent(String(contractId))}`;
  return {
    // {CHECKOUT_SESSION_ID} is a Stripe template literal, left unencoded.
    success_url: `${base}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}&checkout=cancel`,
  };
}

/**
 * Checkout Session params (pure). Always `customer`, never `customer_email`, so
 * every session of a contract hangs off one customer and the
 * double-subscription guard can key on it. The price comes from the stored
 * package, never from the request.
 */
function buildCheckoutSessionParams({ contract, customerId, priceId, taxRateId, nowMs = Date.now() }) {
  const id = String(contract._id);
  const pkg = PACKAGES[contract.package];
  // Derived from the minute bucket so a same-minute retry sends identical
  // params (the idempotency key is per minute too).
  const expiresAt = (Math.floor(nowMs / 60000) + 1) * 60 + SESSION_TTL_S;
  const meta = { contractId: id, contractNumber: contract.number || '', package: contract.package };
  return {
    mode: 'subscription',
    customer: customerId,
    client_reference_id: id,
    metadata: meta,
    line_items: [{ price: priceId, quantity: 1, tax_rates: [taxRateId] }],
    subscription_data: {
      metadata: meta,
      description: `Genius Alarm Monitoring – ${pkg ? pkg.label : contract.package} – ${contract.number || id}`,
    },
    expires_at: expiresAt,
    ...checkoutUrls(id),
  };
}

/** Subscription → billing.* mirror fields (pure; basil + legacy). */
function subscriptionFields(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const pm = sub.default_payment_method && typeof sub.default_payment_method === 'object' ? sub.default_payment_method : null;
  const card = pm && pm.card;
  const out = {
    status: mapStripeSubStatus(sub.status),
    priceId: (item && item.price && item.price.id) || '',
    startedAt: fromUnix(sub.start_date),
    currentPeriodStart: getPeriodStart(sub),
    currentPeriodEnd: getPeriodEnd(sub),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    canceledAt: fromUnix(sub.canceled_at),
    endedAt: fromUnix(sub.ended_at),
  };
  // Only overwrite the card when Stripe gave us one (an unexpanded id or a
  // non-card method leaves the last known card alone).
  if (card) {
    out.pmBrand = card.brand || '';
    out.pmLast4 = card.last4 || '';
    out.pmExpMonth = card.exp_month || null;
    out.pmExpYear = card.exp_year || null;
  }
  return out;
}

/** Subscription invoice total ≠ the contract's agreed monthly total (pure). */
function isAmountMismatch(payment, contract) {
  const expected = contract && contract.pricing && contract.pricing.totalCents;
  if (expected == null) return false;
  if (!['subscription_create', 'subscription_cycle'].includes(payment.billingReason)) return false;
  return Number(payment.totalCents) !== Number(expected);
}

/**
 * Billing aggregates from a contract's ContractPayment rows (pure).
 *  - paid: status paid with money left after refunds; totals are net of refunds
 *    (tax prorated on partial refunds)
 *  - failedCount: invoices with at least one failed attempt (open/uncollectible
 *    after an attempt, or paid on a retry)
 *  - missed (critique #16): per billing period, isMissed()
 *  - consecutiveMissed: newest-first run of missed periods; a period still
 *    waiting for its first attempt is skipped, a paid period ends the run
 *  - lastFailure*: the newest invoice that had a failed attempt (time = when
 *    the row last changed while unpaid, else its invoice date)
 */
function computeAggregates(rows = []) {
  const live = rows.filter((r) => r.status !== 'void' && r.status !== 'draft');
  const agg = {
    firstPaidAt: null,
    lastPaidAt: null,
    paidCount: 0,
    totalPaidCents: 0,
    totalTaxCents: 0,
    failedCount: 0,
    missedCount: 0,
    missedOpenCents: 0,
    consecutiveMissed: 0,
    lastFailureAt: null,
    lastFailureMessage: '',
  };
  const t = (d) => (d ? new Date(d).getTime() : 0);
  let lastFailure = null;
  for (const r of live) {
    const paid = Number(r.amountPaidCents) || 0;
    const refunded = Math.min(Number(r.amountRefundedCents) || 0, paid);
    if (r.status === 'paid' && paid - refunded > 0) {
      agg.paidCount += 1;
      agg.totalPaidCents += paid - refunded;
      const tax = Number(r.taxCents) || 0;
      agg.totalTaxCents += refunded ? Math.round((tax * (paid - refunded)) / paid) : tax;
      if (r.paidAt) {
        if (!agg.firstPaidAt || t(r.paidAt) < t(agg.firstPaidAt)) agg.firstPaidAt = new Date(r.paidAt);
        if (!agg.lastPaidAt || t(r.paidAt) > t(agg.lastPaidAt)) agg.lastPaidAt = new Date(r.paidAt);
      }
    }
    const attempts = Number(r.attemptCount) || 0;
    const hadFailure = r.status === 'paid' ? attempts > 1 : attempts > 0 || Boolean(r.attempted);
    if (hadFailure) {
      agg.failedCount += 1;
      if (!lastFailure || t(r.invoiceCreatedAt) > t(lastFailure.invoiceCreatedAt)) lastFailure = r;
    }
    if (isMissed(r)) {
      agg.missedCount += 1;
      agg.missedOpenCents += Number(r.amountRemainingCents) || 0;
    }
  }
  if (lastFailure) {
    agg.lastFailureAt = new Date((lastFailure.status !== 'paid' && lastFailure.updatedAt) || lastFailure.invoiceCreatedAt || Date.now());
    agg.lastFailureMessage = lastFailure.failureMessage || '';
  }
  // Group by billing period (one invoice per period normally; a re-issued
  // invoice for the same period must not count twice).
  const periods = new Map();
  for (const r of live) {
    const key = t(r.periodStart) || t(r.invoiceCreatedAt);
    const p = periods.get(key) || { key, missed: false, paid: false };
    if (isMissed(r)) p.missed = true;
    if (r.status === 'paid') p.paid = true;
    periods.set(key, p);
  }
  for (const p of [...periods.values()].sort((a, b) => b.key - a.key)) {
    if (p.missed && !p.paid) agg.consecutiveMissed += 1;
    else if (p.paid) break;
    // neither: open and not attempted yet — skip, don't break the run
  }
  return agg;
}

// ---------------------------------------------------------------------------
// Pure helpers (foundation) — handle both basil (2025-03-31+) and legacy shapes
// ---------------------------------------------------------------------------

const idOf = (x) => (x && typeof x === 'object' ? x.id || null : x || null);
const fromUnix = (s) => (s ? new Date(Number(s) * 1000) : null);

/** Subscription id of an invoice: basil parent.subscription_details.subscription, else legacy invoice.subscription. */
function getSubscriptionId(inv) {
  if (!inv) return null;
  const details = inv.parent && inv.parent.subscription_details;
  if (details && details.subscription) return idOf(details.subscription);
  return idOf(inv.subscription);
}

/** Current period end of a subscription: basil items.data[0].current_period_end, else legacy top level. @returns {Date|null} */
function getPeriodEnd(sub) {
  if (!sub) return null;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return fromUnix((item && item.current_period_end) || sub.current_period_end);
}

/** Same for the period start. @returns {Date|null} */
function getPeriodStart(sub) {
  if (!sub) return null;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return fromUnix((item && item.current_period_start) || sub.current_period_start);
}

/** Tax on an invoice: basil total_taxes[].amount, else total_tax_amounts[].amount, else legacy `tax`. */
function getInvoiceTaxCents(inv) {
  if (!inv) return 0;
  const sum = (arr) => arr.reduce((n, t) => n + (Number(t && t.amount) || 0), 0);
  if (Array.isArray(inv.total_taxes)) return sum(inv.total_taxes);
  if (Array.isArray(inv.total_tax_amounts)) return sum(inv.total_tax_amounts);
  return Number(inv.tax) || 0;
}

/**
 * Was this payment missed? Money still owing AND either uncollectible or an
 * open invoice Stripe already tried to charge. (Per billing period, not per
 * retry attempt.)
 * @param {{status: string, attempted?: boolean, attemptCount?: number, amountRemainingCents?: number}} p
 */
function isMissed(p) {
  if (!p || !(Number(p.amountRemainingCents) > 0)) return false;
  if (p.status === 'uncollectible') return true;
  return p.status === 'open' && (Boolean(p.attempted) || Number(p.attemptCount) > 0);
}

/**
 * Stripe invoice → ContractPayment fields (without `contract`, amountRefundedCents,
 * amountMismatch or the email claims, which the caller owns).
 * Service period comes from the first line item when present (a
 * subscription_create invoice has period_start === period_end).
 * @param {import('stripe').Stripe.Invoice} inv
 * @returns {object}
 */
function paymentFromInvoice(inv) {
  const line = inv.lines && inv.lines.data && inv.lines.data[0];
  const period = (line && line.period) || {};
  const p = {
    stripeInvoiceId: inv.id,
    stripeCustomerId: idOf(inv.customer) || '',
    stripeSubscriptionId: getSubscriptionId(inv) || '',
    number: inv.number || '',
    status: inv.status || 'draft',
    billingReason: inv.billing_reason || '',
    attempted: Boolean(inv.attempted),
    attemptCount: Number(inv.attempt_count) || 0,
    nextPaymentAttempt: fromUnix(inv.next_payment_attempt),
    subtotalCents: Number(inv.subtotal) || 0,
    taxCents: getInvoiceTaxCents(inv),
    totalCents: Number(inv.total) || 0,
    amountDueCents: Number(inv.amount_due) || 0,
    amountPaidCents: Number(inv.amount_paid) || 0,
    amountRemainingCents: Number(inv.amount_remaining) || 0,
    currency: inv.currency || 'cad',
    periodStart: fromUnix(period.start || inv.period_start),
    periodEnd: fromUnix(period.end || inv.period_end),
    invoiceCreatedAt: fromUnix(inv.created),
    paidAt: fromUnix(inv.status_transitions && inv.status_transitions.paid_at),
    hostedInvoiceUrl: inv.hosted_invoice_url || '',
    invoicePdfUrl: inv.invoice_pdf || '',
    failureMessage: (inv.last_finalization_error && inv.last_finalization_error.message) || '',
  };
  p.missed = isMissed(p);
  return p;
}

module.exports = {
  createCheckoutForContract,
  createBillingPortalSession,
  cancelSubscription,
  cancelWithoutSubscription,
  applyStripeEvent,
  reconcileContract,
  recomputeBillingAggregates,
  sendReceiptForPayment,
  // Stripe-track extras (reconciler, admin "Email failure notice", tests)
  sendFailureForPayment,
  retryPendingEmails,
  checkoutUrls,
  buildCheckoutSessionParams,
  subscriptionFields,
  isAmountMismatch,
  computeAggregates,
  // internal steps, exported for the stubbed-client tests
  _internal: { refundInvoice, invoiceIdForPaymentIntent, findContract },
  getSubscriptionId,
  getPeriodEnd,
  getPeriodStart,
  getInvoiceTaxCents,
  isMissed,
  paymentFromInvoice,
};

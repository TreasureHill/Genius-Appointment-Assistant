/**
 * Stripe billing: the basil / legacy shape helpers against fixtures, missed /
 * aggregate maths, the catalog gate, Checkout params, webhook signature +
 * livemode guard, and the main applyStripeEvent / checkout flows against a
 * fake Stripe client and an in-memory stand-in for the three Mongo models.
 * No DB, no network.
 */
const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const { t, group, done } = require('./contractHarness')(__filename);
const env = require('../../config/env');
const billing = require('../contracts/billing');
const stripeClient = require('../contracts/stripeClient');
const emails = require('../contracts/emails');
const AlarmContract = require('../../models/AlarmContract');
const ContractPayment = require('../../models/ContractPayment');
const ContractEvent = require('../../models/ContractEvent');
const LotEvent = require('../../models/LotEvent');
const { deriveContractStatus } = require('../contracts/status');

const FIX = path.join(__dirname, 'fixtures', 'stripe');
const fixture = (name, contractId = '') =>
  JSON.parse(require('fs').readFileSync(path.join(FIX, `${name}.json`), 'utf8').replace(/CONTRACT_ID/g, contractId));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

group('invoice / subscription shapes (fixtures)');
t('basil invoice: subscription from parent, taxes from total_taxes, period from the line', () => {
  const inv = fixture('invoice_basil_paid');
  assert.strictEqual(billing.getSubscriptionId(inv), 'sub_basil_1');
  assert.strictEqual(billing.getInvoiceTaxCents(inv), 429);
  const p = billing.paymentFromInvoice(inv);
  assert.strictEqual(p.stripeInvoiceId, 'in_basil_paid');
  assert.strictEqual(p.stripeCustomerId, 'cus_test_1');
  assert.strictEqual(p.status, 'paid');
  assert.strictEqual(p.subtotalCents, 3299);
  assert.strictEqual(p.taxCents, 429);
  assert.strictEqual(p.totalCents, 3728);
  assert.strictEqual(p.amountPaidCents, 3728);
  // subscription_create invoices have period_start === period_end; the line has the real service period
  assert.strictEqual(p.periodStart.getTime(), 1793000000000);
  assert.strictEqual(p.periodEnd.getTime(), 1795592000000);
  assert.strictEqual(p.paidAt.getTime(), 1793000060000);
  assert.strictEqual(p.missed, false);
  assert.ok(!('contract' in p) && !('amountRefundedCents' in p) && !('amountMismatch' in p));
});
t('legacy invoice: top-level subscription, expanded customer, `tax`', () => {
  const inv = fixture('invoice_legacy_failed');
  assert.strictEqual(billing.getSubscriptionId(inv), 'sub_legacy_1');
  const p = billing.paymentFromInvoice(inv);
  assert.strictEqual(p.stripeCustomerId, 'cus_test_1');
  assert.strictEqual(p.taxCents, 325);
  assert.strictEqual(p.attemptCount, 2);
  assert.strictEqual(p.nextPaymentAttempt.getTime(), 1796000000000);
  assert.strictEqual(p.paidAt, null);
  assert.strictEqual(p.missed, true);
});
t('total_tax_amounts + object subscription + uncollectible', () => {
  const inv = fixture('invoice_tax_amounts');
  assert.strictEqual(billing.getSubscriptionId(inv), 'sub_obj_1');
  const p = billing.paymentFromInvoice(inv);
  assert.strictEqual(p.taxCents, 325);
  assert.strictEqual(p.missed, true);
  // no lines → falls back to the invoice's own period
  assert.strictEqual(p.periodEnd.getTime(), 1798270400000);
});
t('basil subscription: periods from the item, card from the expanded payment method', () => {
  const sub = fixture('subscription_basil');
  assert.strictEqual(billing.getPeriodStart(sub).getTime(), 1793000000000);
  assert.strictEqual(billing.getPeriodEnd(sub).getTime(), 1795592000000);
  const f = billing.subscriptionFields(sub);
  assert.strictEqual(f.status, 'active');
  assert.strictEqual(f.priceId, 'price_smart');
  assert.strictEqual(f.startedAt.getTime(), 1793000000000);
  assert.deepStrictEqual([f.pmBrand, f.pmLast4, f.pmExpMonth, f.pmExpYear], ['visa', '4242', 4, 2030]);
  assert.strictEqual(f.cancelAtPeriodEnd, false);
  assert.strictEqual(f.endedAt, null);
});
t('legacy subscription: top-level periods, trialing → active, unexpanded card left alone', () => {
  const sub = fixture('subscription_legacy');
  assert.strictEqual(billing.getPeriodEnd(sub).getTime(), 1795592001000);
  const f = billing.subscriptionFields(sub);
  assert.strictEqual(f.status, 'active');
  assert.strictEqual(f.cancelAtPeriodEnd, true);
  assert.strictEqual(f.canceledAt.getTime(), 1794000000000);
  assert.ok(!('pmLast4' in f), 'no card fields when the payment method is not expanded');
});

group('isMissed (per billing period, critique #16)');
t('open + attempted + owing is missed', () => {
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: true, attemptCount: 1, amountRemainingCents: 3728 }), true);
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: false, attemptCount: 2, amountRemainingCents: 3728 }), true);
});
t('open but not attempted yet (finalised, charge pending) is not missed', () => {
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: false, attemptCount: 0, amountRemainingCents: 3728 }), false);
});
t('uncollectible with money owing is missed; nothing owing never is', () => {
  assert.strictEqual(billing.isMissed({ status: 'uncollectible', amountRemainingCents: 2824 }), true);
  assert.strictEqual(billing.isMissed({ status: 'uncollectible', amountRemainingCents: 0 }), false);
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: true, attemptCount: 3, amountRemainingCents: 0 }), false);
  assert.strictEqual(billing.isMissed({ status: 'paid', attempted: true, attemptCount: 3, amountRemainingCents: 0 }), false);
  assert.strictEqual(billing.isMissed({ status: 'void', attempted: true, amountRemainingCents: 2824 }), false);
  assert.strictEqual(billing.isMissed(null), false);
});

group('computeAggregates');
const D = (iso) => new Date(iso);
const row = (o) => ({ status: 'paid', attempted: true, attemptCount: 1, amountPaidCents: 3728, amountRefundedCents: 0, amountRemainingCents: 0, taxCents: 429, ...o });
t('paid totals are net of refunds; tax prorated', () => {
  const a = billing.computeAggregates([
    row({ periodStart: D('2026-01-03'), paidAt: D('2026-01-03'), invoiceCreatedAt: D('2026-01-03') }),
    row({ periodStart: D('2026-02-03'), paidAt: D('2026-02-03'), invoiceCreatedAt: D('2026-02-03') }),
    row({ periodStart: D('2026-03-03'), paidAt: D('2026-03-03'), invoiceCreatedAt: D('2026-03-03'), amountRefundedCents: 3728 }),
    row({ periodStart: D('2026-04-03'), paidAt: D('2026-04-03'), invoiceCreatedAt: D('2026-04-03'), amountRefundedCents: 1864 }),
    row({ status: 'void', amountPaidCents: 0, periodStart: D('2026-05-03') }),
    row({ status: 'draft', amountPaidCents: 0 }),
  ]);
  assert.strictEqual(a.paidCount, 3);
  assert.strictEqual(a.totalPaidCents, 3728 * 2 + 1864);
  assert.strictEqual(a.totalTaxCents, 429 * 2 + Math.round(429 / 2));
  assert.strictEqual(a.firstPaidAt.toISOString().slice(0, 10), '2026-01-03');
  assert.strictEqual(a.lastPaidAt.toISOString().slice(0, 10), '2026-04-03');
  assert.strictEqual(a.missedCount, 0);
  assert.strictEqual(a.consecutiveMissed, 0);
  assert.strictEqual(a.failedCount, 0);
});
t('missed, failed and consecutive missed periods', () => {
  const a = billing.computeAggregates([
    row({ periodStart: D('2026-01-03'), paidAt: D('2026-01-03'), invoiceCreatedAt: D('2026-01-03') }),
    // paid on the 2nd attempt: a failure, not missed
    row({ periodStart: D('2026-02-03'), paidAt: D('2026-02-05'), invoiceCreatedAt: D('2026-02-03'), attemptCount: 2 }),
    row({ status: 'uncollectible', amountPaidCents: 0, amountRemainingCents: 3728, attemptCount: 8, periodStart: D('2026-03-03'), invoiceCreatedAt: D('2026-03-03') }),
    row({ status: 'open', amountPaidCents: 0, amountRemainingCents: 3728, attemptCount: 3, periodStart: D('2026-04-03'), invoiceCreatedAt: D('2026-04-03'), failureMessage: 'Your card was declined.', updatedAt: D('2026-04-10') }),
    // this month's invoice: finalised, not attempted yet → skipped, doesn't break the run
    row({ status: 'open', attempted: false, attemptCount: 0, amountPaidCents: 0, amountRemainingCents: 3728, periodStart: D('2026-05-03'), invoiceCreatedAt: D('2026-05-03') }),
  ]);
  assert.strictEqual(a.paidCount, 2);
  assert.strictEqual(a.failedCount, 3);
  assert.strictEqual(a.missedCount, 2);
  assert.strictEqual(a.missedOpenCents, 3728 * 2);
  assert.strictEqual(a.consecutiveMissed, 2);
  assert.strictEqual(a.lastFailureMessage, 'Your card was declined.');
  assert.strictEqual(a.lastFailureAt.toISOString().slice(0, 10), '2026-04-10');
});
t('a paid period ends the consecutive run; an empty contract is all zeros', () => {
  const a = billing.computeAggregates([
    row({ status: 'open', amountPaidCents: 0, amountRemainingCents: 3728, attemptCount: 1, periodStart: D('2026-01-03') }),
    row({ periodStart: D('2026-02-03'), paidAt: D('2026-02-03') }),
    row({ status: 'open', amountPaidCents: 0, amountRemainingCents: 3728, attemptCount: 1, periodStart: D('2026-03-03') }),
  ]);
  assert.strictEqual(a.missedCount, 2);
  assert.strictEqual(a.consecutiveMissed, 1);
  const z = billing.computeAggregates([]);
  assert.deepStrictEqual(
    [z.paidCount, z.totalPaidCents, z.missedCount, z.consecutiveMissed, z.firstPaidAt, z.lastFailureMessage],
    [0, 0, 0, 0, null, '']
  );
});
t('amountMismatch only on subscription invoices', () => {
  const c = { pricing: { totalCents: 3728 } };
  assert.strictEqual(billing.isAmountMismatch({ billingReason: 'subscription_create', totalCents: 3728 }, c), false);
  assert.strictEqual(billing.isAmountMismatch({ billingReason: 'subscription_cycle', totalCents: 2824 }, c), true);
  assert.strictEqual(billing.isAmountMismatch({ billingReason: 'manual', totalCents: 100 }, c), false);
  assert.strictEqual(billing.isAmountMismatch({ billingReason: 'subscription_cycle', totalCents: 100 }, { pricing: {} }), false);
});

group('Checkout params');
t('customer (never customer_email), client_reference_id, metadata, expiry, portal URLs', () => {
  const nowMs = Date.UTC(2026, 9, 28, 12, 0, 30);
  const p = billing.buildCheckoutSessionParams({
    contract: { _id: 'abc123', number: 'GA-2026-00042', package: 'smart' },
    customerId: 'cus_1',
    priceId: 'price_smart',
    taxRateId: 'txr_hst',
    nowMs,
  });
  assert.strictEqual(p.mode, 'subscription');
  assert.strictEqual(p.customer, 'cus_1');
  assert.ok(!('customer_email' in p));
  assert.strictEqual(p.client_reference_id, 'abc123');
  assert.deepStrictEqual(p.line_items, [{ price: 'price_smart', quantity: 1, tax_rates: ['txr_hst'] }]);
  assert.strictEqual(p.metadata.contractId, 'abc123');
  assert.strictEqual(p.subscription_data.metadata.contractId, 'abc123');
  assert.strictEqual(p.subscription_data.metadata.package, 'smart');
  const ttl = p.expires_at - nowMs / 1000;
  assert.ok(ttl >= 3600 && ttl <= 3660, `expires ~1h out (${ttl})`);
  // same minute → identical params (idempotent retry)
  assert.deepStrictEqual(billing.buildCheckoutSessionParams({ contract: { _id: 'abc123', number: 'GA-2026-00042', package: 'smart' }, customerId: 'cus_1', priceId: 'price_smart', taxRateId: 'txr_hst', nowMs: nowMs + 20000 }), p);
  assert.strictEqual(p.success_url, `${env.appUrl}/portal/pay?contract=abc123&checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  assert.strictEqual(p.cancel_url, `${env.appUrl}/portal/pay?contract=abc123&checkout=cancel`);
});

group('catalog gate (critique #9)');
const goodPrice = (key, extra = {}) => ({
  id: `price_${key}`,
  active: true,
  unit_amount: key === 'basic' ? 2499 : 3299,
  currency: 'cad',
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  tax_behavior: 'exclusive',
  livemode: false,
  lookup_key: key === 'basic' ? 'genius_monitoring_basic_monthly' : 'genius_monitoring_smart_monthly',
  ...extra,
});
const goodRate = (extra = {}) => ({ id: 'txr_hst', percentage: 13, inclusive: false, active: true, livemode: false, ...extra });
t('a matching catalog has no problems; unspecified tax_behavior is accepted', () => {
  assert.deepStrictEqual(
    stripeClient.catalogProblems({ prices: { basic: goodPrice('basic'), smart: goodPrice('smart', { tax_behavior: 'unspecified' }) }, taxRate: goodRate(), taxRateId: 'txr_hst', mode: 'test' }),
    []
  );
  assert.deepStrictEqual(
    stripeClient.catalogProblems({ prices: { basic: goodPrice('basic', { tax_behavior: null }), smart: goodPrice('smart') }, taxRate: goodRate(), taxRateId: 'txr_hst', mode: 'test' }),
    []
  );
});
t('wrong amount / currency / interval / inclusive price are problems', () => {
  const probs = stripeClient.catalogProblems({
    prices: {
      basic: goodPrice('basic', { unit_amount: 2500, currency: 'usd' }),
      smart: goodPrice('smart', { recurring: { interval: 'year' }, tax_behavior: 'inclusive', active: false }),
    },
    taxRate: goodRate(),
    taxRateId: 'txr_hst',
    mode: 'test',
  });
  assert.strictEqual(probs.length, 5, probs.join('\n'));
});
t('the tax rate is the real gate: 13, exclusive, active, same mode', () => {
  const prices = { basic: goodPrice('basic'), smart: goodPrice('smart') };
  const check = (taxRate, taxRateId = 'txr_hst', mode = 'test') => stripeClient.catalogProblems({ prices, taxRate, taxRateId, mode });
  assert.strictEqual(check(goodRate({ inclusive: true })).length, 1);
  assert.strictEqual(check(goodRate({ percentage: 15 })).length, 1);
  assert.strictEqual(check(goodRate({ active: false })).length, 1);
  assert.strictEqual(check(null).length, 1);
  assert.strictEqual(check(null, '').length, 1);
  // test-mode objects behind a live key: every object is flagged
  assert.strictEqual(check(goodRate(), 'txr_hst', 'live').length, 3);
});
t('safeStripeMessage never echoes key-shaped strings', () => {
  assert.strictEqual(stripeClient.safeStripeMessage({ type: 'StripeAuthenticationError', message: 'Invalid API Key provided: sk_live_abc' }), 'Stripe rejected the API key (check STRIPE_SECRET_KEY)');
  assert.ok(!/sk_test_123/.test(stripeClient.safeStripeMessage({ message: 'oops sk_test_123abc failed' })));
});

group('webhook signature + livemode guard');
t('constructEvent accepts a locally signed payload and rejects tampering / wrong secret', () => {
  const secret = 'whsec_unit_test';
  const raw = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_1' } } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  assert.strictEqual(Stripe.webhooks.constructEvent(Buffer.from(raw), header, secret).type, 'invoice.paid');
  assert.throws(() => Stripe.webhooks.constructEvent(Buffer.from(raw.replace('in_1', 'in_2')), header, secret));
  assert.throws(() => Stripe.webhooks.constructEvent(Buffer.from(raw), header, 'whsec_other'));
  const old = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.throws(() => Stripe.webhooks.constructEvent(Buffer.from(raw), old, secret), /tolerance/i);
});
t('expectedLivemode follows the key prefix', () => {
  const saved = env.stripe.mode;
  try {
    env.stripe.mode = 'test';
    assert.strictEqual(stripeClient.expectedLivemode(), false);
    env.stripe.mode = 'live';
    assert.strictEqual(stripeClient.expectedLivemode(), true);
    env.stripe.mode = '';
    assert.strictEqual(stripeClient.expectedLivemode(), null);
  } finally {
    env.stripe.mode = saved;
  }
});
t('unhandled event types are ignored without touching Stripe', async () => {
  assert.deepStrictEqual(await billing.applyStripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_x' } } }), { ignored: 'unhandled_type' });
});

// ---------------------------------------------------------------------------
// Flows against a fake Stripe client + in-memory models
// ---------------------------------------------------------------------------

// Tiny Mongo-ish matcher / updater, just enough for billing.js's queries.
const getPath = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const setPath = (o, p, val) => {
  const ks = p.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {};
  cur[ks[ks.length - 1]] = val;
};
const norm = (v) => (v instanceof mongoose.Types.ObjectId ? String(v) : v instanceof Date ? v.getTime() : v);
const eq = (a, b) => (b === null ? a == null : norm(a) === norm(b));
function matchCond(val, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$in': return arg.some((x) => eq(val, x));
        case '$nin': return !arg.some((x) => eq(val, x));
        case '$ne': return !eq(val, arg);
        case '$lt': return val != null && norm(val) < norm(arg);
        case '$gt': return val != null && norm(val) > norm(arg);
        case '$gte': return val != null && norm(val) >= norm(arg);
        case '$lte': return val != null && norm(val) <= norm(arg);
        case '$not': return !matchCond(val, arg);
        default: throw new Error(`fake: unsupported operator ${op}`);
      }
    });
  }
  return eq(val, cond);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    return matchCond(getPath(doc, k), cond);
  });
}
function applyUpdate(doc, u) {
  for (const [k, v] of Object.entries(u.$set || {})) setPath(doc, k, v);
  for (const [k, v] of Object.entries(u.$inc || {})) setPath(doc, k, (getPath(doc, k) || 0) + v);
}
// Deep copy that keeps ObjectIds and Dates intact (like a .lean() result).
const clone = (o) => {
  if (o == null || typeof o !== 'object' || o instanceof Date || o instanceof mongoose.Types.ObjectId) return o;
  if (Array.isArray(o)) return o.map(clone);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clone(v)]));
};
const q = (v) => {
  const p = Promise.resolve(clone(v));
  const chain = { lean: () => p, select: () => chain, sort: () => chain, limit: () => chain, then: (a, b) => p.then(a, b) };
  return chain;
};
function fakeModel(Model, rows) {
  const originals = {};
  const patch = {
    findById: (id) => q(rows.find((r) => String(r._id) === String(id)) || null),
    findOne: (f) => q(rows.find((r) => matches(r, f)) || null),
    find: (f) => q(rows.filter((r) => matches(r, f))),
    exists: async (f) => (rows.some((r) => matches(r, f)) ? { _id: 1 } : null),
    create: async (doc) => {
      const d = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...clone(doc) };
      rows.push(d);
      return d;
    },
    updateOne: async (f, u) => {
      const d = rows.find((r) => matches(r, f));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(d, u);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndUpdate: (f, u, opts = {}) => {
      let d = rows.find((r) => matches(r, f));
      let before = clone(d);
      if (!d && opts.upsert) {
        // The unique stripeInvoiceId index: an upsert whose filter missed an
        // existing row fails the insert, like Mongo does.
        if (f.stripeInvoiceId && rows.some((r) => r.stripeInvoiceId === f.stripeInvoiceId)) {
          const err = new Error('E11000 duplicate key');
          err.code = 11000;
          return { lean: () => Promise.reject(err) };
        }
        d = { _id: new mongoose.Types.ObjectId(), receiptEmail: { claimedAt: null, sentAt: null, error: '', attempts: 0 }, failureEmail: { claimedAt: null, sentAt: null, error: '', attempts: 0 }, amountRefundedCents: 0 };
        for (const [k, v] of Object.entries(f)) if (!k.startsWith('$')) setPath(d, k, v);
        rows.push(d);
        before = null;
      }
      if (d) {
        applyUpdate(d, u);
        d.updatedAt = new Date();
      }
      return q(opts.new ? d || null : before || null);
    },
  };
  for (const k of Object.keys(patch)) {
    originals[k] = Object.prototype.hasOwnProperty.call(Model, k) ? Model[k] : undefined;
    Model[k] = patch[k];
  }
  return () => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete Model[k];
      else Model[k] = v;
    }
  };
}

const db = { contracts: [], payments: [], events: [], lotEvents: [] };
const sent = [];
const alerts = [];
const restorers = [];
const savedEnv = { ...env.stripe };
const savedEmails = { sendContractEmail: emails.sendContractEmail, sendAdminAlert: emails.sendAdminAlert };

function makeContract(extra = {}) {
  const c = {
    _id: new mongoose.Types.ObjectId(),
    number: 'GA-2026-00042',
    lot: new mongoose.Types.ObjectId(),
    project: new mongoose.Types.ObjectId(),
    isCurrent: true,
    property: { projectName: 'Treasure Hill Woods', lotNumber: '6' },
    purchasers: [{ role: 'buyer', name: 'Ann Buyer', email: 'ann@example.com', phone: '' }],
    signingMode: 'remote',
    package: 'smart',
    pricing: { unitCents: 3299, taxBps: 1300, taxCents: 429, totalCents: 3728, currency: 'cad' },
    needsAttention: '',
    envelope: { status: 'completed' },
    billing: { status: 'none', customerId: '', checkoutSessionId: '', checkoutExpiresAt: null },
    reminders: { enabled: true },
    invoiceEmails: { enabled: true },
    cancelReason: '',
    ...extra,
  };
  c.status = deriveContractStatus(c);
  db.contracts.push(c);
  return c;
}
const contractNow = (c) => db.contracts.find((x) => String(x._id) === String(c._id));

// Fake Stripe: a table of handlers; every call is recorded.
const calls = [];
function fakeStripe(h) {
  const rec = (name) => async (...args) => {
    calls.push({ name, args });
    if (!h[name]) throw new Error(`fake stripe: unexpected call ${name}`);
    return h[name](...args);
  };
  const list = (name) => (...args) => {
    const p = rec(name)(...args);
    // auto-pagination (`for await`) over a single page
    p[Symbol.asyncIterator] = async function* it() {
      const page = await p;
      yield* page.data || [];
    };
    return p;
  };
  return {
    prices: { list: list('prices.list'), retrieve: rec('prices.retrieve') },
    taxRates: { retrieve: rec('taxRates.retrieve') },
    customers: { create: rec('customers.create') },
    checkout: { sessions: { create: rec('sessions.create'), retrieve: rec('sessions.retrieve'), list: list('sessions.list'), expire: rec('sessions.expire') } },
    billingPortal: {
      sessions: { create: rec('portal.create') },
      configurations: { list: rec('portalConfig.list'), create: rec('portalConfig.create') },
    },
    subscriptions: { retrieve: rec('subscriptions.retrieve'), cancel: rec('subscriptions.cancel'), update: rec('subscriptions.update') },
    invoices: { retrieve: rec('invoices.retrieve'), list: list('invoices.list') },
    invoicePayments: { list: list('invoicePayments.list') },
    refunds: { create: rec('refunds.create') },
    charges: { retrieve: rec('charges.retrieve'), list: list('charges.list') },
    paymentIntents: { retrieve: rec('paymentIntents.retrieve') },
    events: { retrieve: rec('events.retrieve') },
  };
}
const called = (name) => calls.filter((c) => c.name === name);
const catalogHandlers = {
  'prices.list': async () => ({ data: [goodPrice('basic'), goodPrice('smart')] }),
  'taxRates.retrieve': async () => goodRate(),
};

group('flows (fake Stripe, in-memory models)');
t('setup', () => {
  restorers.push(fakeModel(AlarmContract, db.contracts));
  restorers.push(fakeModel(ContractPayment, db.payments));
  restorers.push(fakeModel(ContractEvent, db.events));
  restorers.push(fakeModel(LotEvent, db.lotEvents));
  Object.assign(env.stripe, { configured: true, billable: true, taxRateId: 'txr_hst', mode: 'test', priceBasic: '', priceSmart: '', testClocks: false });
  emails.sendContractEmail = async (a) => {
    sent.push({ kind: a.kind, contractId: String(a.contract && a.contract._id), data: a.data });
    return { ok: true, messageId: `m${sent.length}` };
  };
  emails.sendAdminAlert = async (a) => {
    alerts.push(a);
    return { ok: true };
  };
});

t('checkout: guards — portal user must be linked, package must be set, no live subscription', async () => {
  stripeClient._setClientForTests(fakeStripe({ ...catalogHandlers }));
  const c = makeContract();
  await assert.rejects(billing.createCheckoutForContract(c, { email: 'x@example.com', contracts: [] }), { code: 'no_portal_user' });
  const missing = makeContract({ package: null, needsAttention: 'package_missing' });
  await assert.rejects(billing.createCheckoutForContract(missing, { contracts: [missing._id] }), { code: 'package_missing' });
  const live = makeContract({ billing: { status: 'active', subscriptionId: 'sub_live', customerId: 'cus_9' } });
  await assert.rejects(billing.createCheckoutForContract(live, { contracts: [live._id] }), { code: 'already_subscribed' });
  const draft = makeContract({ envelope: { status: 'sent' } });
  await assert.rejects(billing.createCheckoutForContract(draft, { contracts: [draft._id] }), { code: 'invalid_state' });
  env.stripe.billable = false;
  await assert.rejects(billing.createCheckoutForContract(c, { contracts: [c._id] }), { code: 'not_configured' });
  env.stripe.billable = true;
});

t('checkout: catalog mismatch blocks before anything is created', async () => {
  calls.length = 0;
  stripeClient._setClientForTests(fakeStripe({ ...catalogHandlers, 'taxRates.retrieve': async () => goodRate({ inclusive: true }) }));
  const c = makeContract();
  await assert.rejects(billing.createCheckoutForContract(c, { contracts: [c._id] }), (e) => e.code === 'stripe_catalog_mismatch' && e.problems.length === 1);
  assert.strictEqual(called('customers.create').length, 0);
  assert.strictEqual(called('sessions.create').length, 0);
});

t('checkout: creates the customer idempotently, opens a session, reuses it', async () => {
  calls.length = 0;
  stripeClient._setClientForTests(
    fakeStripe({
      ...catalogHandlers,
      'customers.create': async () => ({ id: 'cus_new' }),
      'sessions.create': async (params) => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: params.expires_at, status: 'open' }),
      'sessions.retrieve': async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', status: 'open' }),
    })
  );
  const c = makeContract();
  const user = { email: 'ann@example.com', contracts: [c._id] };
  const r = await billing.createCheckoutForContract(c, user);
  assert.deepStrictEqual(r, { url: 'https://checkout.stripe.com/c/pay/cs_1', sessionId: 'cs_1', reused: false });
  const [custParams, custOpts] = called('customers.create')[0].args;
  assert.strictEqual(custOpts.idempotencyKey, `cust-${c._id}`);
  assert.strictEqual(custParams.email, 'ann@example.com');
  assert.strictEqual(custParams.metadata.contractId, String(c._id));
  const [params, opts] = called('sessions.create')[0].args;
  assert.strictEqual(params.customer, 'cus_new');
  assert.ok(!('customer_email' in params));
  assert.strictEqual(params.line_items[0].price, 'price_smart');
  assert.ok(/^checkout-/.test(opts.idempotencyKey));
  const after = contractNow(c);
  assert.strictEqual(after.billing.customerId, 'cus_new');
  assert.strictEqual(after.billing.status, 'checkout_open');
  assert.strictEqual(after.billing.checkoutSessionId, 'cs_1');
  assert.ok(db.events.some((e) => e.type === 'checkout_started' && String(e.contract) === String(c._id)));
  // second click: same session, no new customer / session
  const again = await billing.createCheckoutForContract(c, user);
  assert.strictEqual(again.reused, true);
  assert.strictEqual(called('customers.create').length, 1);
  assert.strictEqual(called('sessions.create').length, 1);
});

t('checkout.session.completed links the subscription, mirrors it, records + receipts the first invoice once', async () => {
  calls.length = 0;
  sent.length = 0;
  const c = makeContract({ billing: { status: 'checkout_open', customerId: 'cus_test_1', checkoutSessionId: 'cs_A', checkoutExpiresAt: new Date(Date.now() + 3600e3) } });
  const id = String(c._id);
  stripeClient._setClientForTests(
    fakeStripe({
      'sessions.retrieve': async () => ({ id: 'cs_A', mode: 'subscription', status: 'complete', client_reference_id: id, customer: 'cus_test_1', subscription: 'sub_basil_1', invoice: 'in_basil_paid' }),
      'subscriptions.retrieve': async () => fixture('subscription_basil', id),
      'invoices.retrieve': async () => fixture('invoice_basil_paid', id),
    })
  );
  const r = await billing.applyStripeEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_A' } } });
  assert.strictEqual(r.handled, true);
  const after = contractNow(c);
  assert.strictEqual(after.billing.subscriptionId, 'sub_basil_1');
  assert.strictEqual(after.billing.status, 'active');
  assert.strictEqual(after.status, 'active');
  assert.strictEqual(after.billing.pmLast4, '4242');
  assert.strictEqual(after.billing.currentPeriodEnd.getTime(), 1795592000000);
  assert.strictEqual(after.billing.checkoutExpiresAt, null);
  assert.strictEqual(after.billing.paidCount, 1);
  assert.strictEqual(after.billing.totalPaidCents, 3728);
  const pay = db.payments.find((p) => p.stripeInvoiceId === 'in_basil_paid');
  assert.strictEqual(String(pay.contract), id);
  assert.strictEqual(pay.amountMismatch, false);
  assert.ok(pay.receiptEmail.sentAt instanceof Date);
  const evs = db.events.filter((e) => String(e.contract) === id).map((e) => e.type);
  assert.ok(evs.includes('activated') && evs.includes('checkout_completed') && evs.includes('payment_succeeded'), evs.join(','));
  assert.ok(db.lotEvents.some((e) => e.type === 'contract' && /active/i.test(e.message)), 'activation mirrored to the lot');
  assert.deepStrictEqual(sent.map((s) => s.kind), ['receipt']);
  // invoice.paid arriving afterwards (and replays) send nothing more
  await billing.applyStripeEvent({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_basil_paid' } } });
  await billing.applyStripeEvent({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_basil_paid' } } });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(db.payments.filter((p) => p.stripeInvoiceId === 'in_basil_paid').length, 1);
  assert.strictEqual(db.events.filter((e) => String(e.contract) === id && e.type === 'activated').length, 1);
  assert.strictEqual(contractNow(c).billing.paidCount, 1);
});

t('double-subscription guard: a second completed Checkout is cancelled and refunded (basil invoicePayments)', async () => {
  calls.length = 0;
  alerts.length = 0;
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_first', customerId: 'cus_d' } });
  const id = String(c._id);
  stripeClient._setClientForTests(
    fakeStripe({
      'sessions.retrieve': async () => ({ id: 'cs_dup', mode: 'subscription', status: 'complete', client_reference_id: id, customer: 'cus_d', subscription: 'sub_dup', invoice: 'in_dup' }),
      'subscriptions.retrieve': async () => ({ id: 'sub_dup', status: 'active' }),
      'subscriptions.cancel': async (sid) => ({ id: sid, status: 'canceled' }),
      'invoices.list': async () => ({ data: [{ id: 'in_dup', status: 'paid' }] }),
      'invoicePayments.list': async () => ({ data: [{ status: 'paid', invoice: 'in_dup', payment: { type: 'payment_intent', payment_intent: 'pi_dup' } }] }),
      'refunds.create': async () => ({ id: 're_1' }),
    })
  );
  const r = await billing.applyStripeEvent({ id: 'evt_dup', type: 'checkout.session.completed', data: { object: { id: 'cs_dup' } } });
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(called('subscriptions.cancel')[0].args[0], 'sub_dup');
  assert.deepStrictEqual(called('invoicePayments.list')[0].args[0], { invoice: 'in_dup', limit: 10 });
  const [refund, refundOpts] = called('refunds.create')[0].args;
  assert.strictEqual(refund.payment_intent, 'pi_dup');
  assert.strictEqual(refundOpts.idempotencyKey, 'dup-refund-pi_dup');
  assert.strictEqual(called('refunds.create').length, 1, 'the session invoice and the listed invoice are refunded once');
  assert.strictEqual(contractNow(c).billing.subscriptionId, 'sub_first');
  assert.strictEqual(alerts[0].alertKind, 'double_subscription');
});

t('checkout.session.expired resets checkout_open (compare-and-set on the session id)', async () => {
  const c = makeContract({ billing: { status: 'checkout_open', customerId: 'cus_e', checkoutSessionId: 'cs_old', checkoutExpiresAt: new Date() } });
  stripeClient._setClientForTests(
    fakeStripe({ 'sessions.retrieve': async (sid) => ({ id: sid, mode: 'subscription', status: 'expired', client_reference_id: String(c._id), customer: 'cus_e' }) })
  );
  // an older session expiring must not clear the current one
  contractNow(c).billing.checkoutSessionId = 'cs_new';
  await billing.applyStripeEvent({ id: 'evt_e1', type: 'checkout.session.expired', data: { object: { id: 'cs_old' } } });
  assert.strictEqual(contractNow(c).billing.status, 'checkout_open');
  await billing.applyStripeEvent({ id: 'evt_e2', type: 'checkout.session.expired', data: { object: { id: 'cs_new' } } });
  const after = contractNow(c);
  assert.strictEqual(after.billing.status, 'none');
  assert.strictEqual(after.billing.checkoutSessionId, '');
  assert.ok(db.events.some((e) => e.type === 'checkout_expired' && String(e.contract) === String(c._id)));
});

t('invoice.payment_failed: missed, past_due, failure email + admin alert once', async () => {
  sent.length = 0;
  alerts.length = 0;
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_legacy_1', customerId: 'cus_test_1' } });
  stripeClient._setClientForTests(
    fakeStripe({
      'invoices.retrieve': async () => fixture('invoice_legacy_failed'),
      'paymentIntents.retrieve': async () => ({ id: 'pi_legacy_1', last_payment_error: { message: 'Your card was declined.' } }),
      'subscriptions.retrieve': async () => ({ ...fixture('subscription_legacy'), status: 'past_due', cancel_at_period_end: false, canceled_at: null }),
    })
  );
  await billing.applyStripeEvent({ id: 'evt_f1', type: 'invoice.payment_failed', data: { object: { id: 'in_legacy_failed' } } });
  await billing.applyStripeEvent({ id: 'evt_f2', type: 'invoice.payment_failed', data: { object: { id: 'in_legacy_failed' } } });
  const after = contractNow(c);
  assert.strictEqual(after.status, 'past_due');
  assert.strictEqual(after.billing.missedCount, 1);
  assert.strictEqual(after.billing.missedOpenCents, 2824);
  assert.strictEqual(after.billing.lastFailureMessage, 'Your card was declined.');
  const pay = db.payments.find((p) => p.stripeInvoiceId === 'in_legacy_failed');
  assert.strictEqual(pay.missed, true);
  // legacy subscription_cycle total 2824 ≠ smart 3728
  assert.strictEqual(pay.amountMismatch, true);
  assert.deepStrictEqual(sent.map((s) => s.kind), ['payment_failed']);
  assert.strictEqual(sent[0].data.failureMessage, 'Your card was declined.');
  // attemptCount is 2 in the fixture, so this isn't the first failure: no new admin alert
  assert.strictEqual(alerts.length, 0);
});

t('charge.refunded maps the charge to its invoice through invoicePayments (basil)', async () => {
  calls.length = 0;
  const c = db.contracts.find((x) => x.billing.subscriptionId === 'sub_basil_1');
  stripeClient._setClientForTests(
    fakeStripe({
      'charges.retrieve': async () => fixture('charge_refunded_basil'),
      'invoicePayments.list': async () => fixture('invoice_payments_by_pi'),
    })
  );
  const r = await billing.applyStripeEvent({ id: 'evt_r', type: 'charge.refunded', data: { object: { id: 'ch_basil_1' } } });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(called('invoicePayments.list')[0].args[0], { payment: { type: 'payment_intent', payment_intent: 'pi_basil_1' }, limit: 1 });
  assert.strictEqual(db.payments.find((p) => p.stripeInvoiceId === 'in_basil_paid').amountRefundedCents, 3728);
  assert.strictEqual(contractNow(c).billing.totalPaidCents, 0);
  assert.strictEqual(contractNow(c).billing.paidCount, 0);
  assert.ok(db.events.some((e) => e.type === 'payment_refunded'));
  // replay: no change, no second event
  const again = await billing.applyStripeEvent({ id: 'evt_r', type: 'charge.refunded', data: { object: { id: 'ch_basil_1' } } });
  assert.strictEqual(again.changed, false);
  assert.strictEqual(db.events.filter((e) => e.type === 'payment_refunded').length, 1);
});

t('events for unknown contracts are ignored (200), not errors', async () => {
  stripeClient._setClientForTests(
    fakeStripe({ 'subscriptions.retrieve': async () => ({ id: 'sub_nobody', status: 'active', metadata: {}, items: { data: [] } }) })
  );
  assert.deepStrictEqual(
    await billing.applyStripeEvent({ id: 'evt_u', type: 'customer.subscription.updated', data: { object: { id: 'sub_nobody' } } }),
    { ignored: 'unknown_contract' }
  );
});

t('cancel now: syncs, logs canceled (mirrored), emails once', async () => {
  sent.length = 0;
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_cancel', customerId: 'cus_c' } });
  const ended = { id: 'sub_cancel', customer: 'cus_c', status: 'canceled', start_date: 1793000000, canceled_at: 1794000000, ended_at: 1794000000, items: { data: [] } };
  stripeClient._setClientForTests(
    fakeStripe({ 'subscriptions.cancel': async () => ended, 'subscriptions.retrieve': async () => ended })
  );
  const out = await billing.cancelSubscription(c, { atPeriodEnd: false, reason: 'Moved out', user: 'staff@example.com' });
  assert.strictEqual(out.status, 'canceled');
  assert.strictEqual(out.cancelReason, 'Moved out');
  assert.deepStrictEqual(called('subscriptions.cancel').slice(-1)[0].args, ['sub_cancel', { prorate: false, invoice_now: false, cancellation_details: { comment: 'Moved out' } }]);
  const ev = db.events.find((e) => e.type === 'canceled' && String(e.contract) === String(c._id));
  assert.ok(ev && ev.actor === 'user' && /Moved out/.test(ev.message));
  assert.deepStrictEqual(sent.map((s) => s.kind), ['canceled']);
});

t('reconcile rebuilds deleted payment rows without re-emailing old receipts, then is a no-op', async () => {
  sent.length = 0;
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_basil_1x', customerId: 'cus_rec' } });
  const id = String(c._id);
  const sub = { ...fixture('subscription_basil', id), id: 'sub_basil_1x', customer: 'cus_rec' };
  const old = { ...fixture('invoice_basil_paid', id), id: 'in_rec_old', customer: 'cus_rec', status_transitions: { paid_at: 1700000000 } };
  old.parent.subscription_details.subscription = 'sub_basil_1x';
  stripeClient._setClientForTests(
    fakeStripe({
      'subscriptions.retrieve': async () => sub,
      'invoices.list': async () => ({ data: [old, { id: 'in_draft', status: 'draft' }] }),
      'charges.list': async () => ({ data: [{ id: 'ch_ok', amount_refunded: 0 }] }),
    })
  );
  const first = await billing.reconcileContract(id);
  assert.strictEqual(first.payments, 1);
  assert.ok(first.fixes >= 2, `subscription mirror + payments (${first.fixes})`);
  assert.strictEqual(first.status, 'active');
  assert.ok(db.payments.some((p) => p.stripeInvoiceId === 'in_rec_old'));
  assert.ok(!db.payments.some((p) => p.stripeInvoiceId === 'in_draft'));
  assert.strictEqual(sent.length, 0, 'a year-old receipt is not re-sent');
  assert.ok(contractNow(c).billing.lastReconciledAt instanceof Date);
  const second = await billing.reconcileContract(id);
  assert.strictEqual(second.fixes, 0);
  assert.ok(db.events.filter((e) => e.type === 'reconcile_fix' && String(e.contract) === id).length === first.fixes);
});

t('reconciler worker and verifyStripe are inert without Stripe', async () => {
  const saved = env.stripe.configured;
  env.stripe.configured = false;
  stripeClient._setClientForTests(null);
  try {
    assert.deepStrictEqual(await require('../../workers/stripeReconciler').runOnce(), { skipped: 'not_configured' });
    const h = await stripeClient.verifyStripe();
    assert.strictEqual(h.ok, false);
    assert.strictEqual(h.message, 'Stripe not configured');
    await assert.rejects(billing.applyStripeEvent({ id: 'e', type: 'invoice.paid', data: { object: { id: 'in_1' } } }), { code: 'not_configured' });
  } finally {
    env.stripe.configured = saved;
  }
});

// The basil fixtures with their invoice / subscription / customer ids swapped,
// so a flow test doesn't resolve to an earlier test's contract.
const renamed = (name, id, map) => {
  let text = JSON.stringify(fixture(name, id));
  for (const [from, to] of Object.entries(map)) text = text.split(`"${from}"`).join(`"${to}"`);
  return JSON.parse(text);
};

t('invoices of a second (duplicate) subscription never become payments or receipts', async () => {
  sent.length = 0;
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_first', customerId: 'cus_dupinv' } });
  const id = String(c._id);
  // a paid invoice of sub_second, still carrying our contractId metadata
  const map = { in_basil_paid: 'in_dupinv', sub_basil_1: 'sub_second', cus_test_1: 'cus_dupinv' };
  stripeClient._setClientForTests(
    fakeStripe({
      'invoices.retrieve': async () => renamed('invoice_basil_paid', id, map),
      'invoices.list': async () => ({ data: [renamed('invoice_basil_paid', id, map)] }),
      'subscriptions.retrieve': async () => renamed('subscription_basil', id, { sub_basil_1: 'sub_first', cus_test_1: 'cus_dupinv' }),
      'charges.list': async () => ({ data: [] }),
    })
  );
  const r = await billing.applyStripeEvent({ id: 'evt_dupinv', type: 'invoice.paid', data: { object: { id: 'in_dupinv' } } });
  assert.strictEqual(r.ignored, 'other_subscription');
  await billing.reconcileContract(id);
  assert.strictEqual(db.payments.filter((p) => String(p.contract) === id).length, 0);
  assert.strictEqual(sent.filter((x) => x.kind === 'receipt' && x.contractId === id).length, 0);
  assert.strictEqual(contractNow(c).billing.paidCount || 0, 0);
});

t('an older invoice read finishing last does not undo a newer one (paid stays paid)', async () => {
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_race', customerId: 'cus_race' } });
  const id = String(c._id);
  const map = { in_basil_paid: 'in_race', sub_basil_1: 'sub_race', cus_test_1: 'cus_race' };
  const paid = renamed('invoice_basil_paid', id, map);
  const open = { ...renamed('invoice_basil_paid', id, map), status: 'open', amount_paid: 0, amount_remaining: paid.total, status_transitions: {} };
  let releaseOpen;
  const openGate = new Promise((res) => { releaseOpen = res; });
  stripeClient._setClientForTests(
    fakeStripe({
      // invoice.finalized's read starts first but answers last
      'invoices.retrieve': async () => (calls.filter((x) => x.name === 'invoices.retrieve').length === 1 ? openGate.then(() => open) : paid),
      'subscriptions.retrieve': async () => renamed('subscription_basil', id, map),
    })
  );
  calls.length = 0;
  const first = billing.applyStripeEvent({ id: 'evt_fin', type: 'invoice.finalized', data: { object: { id: 'in_race' } } });
  await new Promise((res) => setTimeout(res, 5));
  await billing.applyStripeEvent({ id: 'evt_paid', type: 'invoice.paid', data: { object: { id: 'in_race' } } });
  assert.strictEqual(db.payments.find((p) => p.stripeInvoiceId === 'in_race').status, 'paid');
  releaseOpen();
  await first;
  const row = db.payments.filter((p) => p.stripeInvoiceId === 'in_race');
  assert.strictEqual(row.length, 1);
  assert.strictEqual(row[0].status, 'paid');
  assert.strictEqual(contractNow(c).billing.paidCount, 1);
});

t('billing portal sessions are pinned to a code-made configuration with cancel / plan switching off', async () => {
  const c = makeContract({ billing: { status: 'active', subscriptionId: 'sub_p', customerId: 'cus_p' } });
  calls.length = 0;
  stripeClient._setClientForTests(
    fakeStripe({
      'portalConfig.list': async () => ({ data: [{ id: 'bpc_default', metadata: {}, features: { subscription_cancel: { enabled: true } } }] }),
      'portalConfig.create': async () => ({ id: 'bpc_locked' }),
      'portal.create': async () => ({ url: 'https://billing.stripe.test/s' }),
    })
  );
  const r = await billing.createBillingPortalSession(c, { returnUrl: 'https://app.test/portal' });
  assert.strictEqual(r.url, 'https://billing.stripe.test/s');
  const cfg = called('portalConfig.create')[0].args[0];
  assert.strictEqual(cfg.features.subscription_cancel.enabled, false);
  assert.strictEqual(cfg.features.subscription_update.enabled, false);
  assert.strictEqual(cfg.features.payment_method_update.enabled, true);
  assert.strictEqual(called('portal.create')[0].args[0].configuration, 'bpc_locked');
  await billing.createBillingPortalSession(c);
  assert.strictEqual(called('portalConfig.list').length, 1, 'cached after the first lookup');
  assert.strictEqual(called('portal.create')[1].args[0].configuration, 'bpc_locked');
});

t('closing a signed contract that never set up payment: open Checkout expired, canceled, no email', async () => {
  sent.length = 0;
  calls.length = 0;
  const c = makeContract({ billing: { status: 'checkout_open', customerId: 'cus_close', checkoutSessionId: 'cs_close', checkoutExpiresAt: new Date(Date.now() + 3600e3) } });
  stripeClient._setClientForTests(fakeStripe({ 'sessions.expire': async (sid) => ({ id: sid, status: 'expired' }) }));
  assert.strictEqual(c.status, 'awaiting_payment');
  await billing.cancelWithoutSubscription(c._id, { reason: 'buyer declined monitoring', user: 'mariyam' });
  assert.strictEqual(called('sessions.expire')[0].args[0], 'cs_close');
  const after = contractNow(c);
  assert.strictEqual(after.status, 'canceled');
  assert.strictEqual(after.cancelReason, 'buyer declined monitoring');
  assert.ok(db.events.some((e) => e.type === 'canceled' && String(e.contract) === String(c._id)));
  assert.strictEqual(sent.length, 0, 'nothing was billed, so no cancellation email');
  // the late checkout.session.expired webhook doesn't reopen it
  stripeClient._setClientForTests(
    fakeStripe({ 'sessions.retrieve': async (sid) => ({ id: sid, mode: 'subscription', status: 'expired', client_reference_id: String(c._id), customer: 'cus_close' }) })
  );
  await billing.applyStripeEvent({ id: 'evt_close', type: 'checkout.session.expired', data: { object: { id: 'cs_close' } } });
  assert.strictEqual(contractNow(c).status, 'canceled');
});

t('teardown', () => {
  restorers.forEach((r) => r());
  Object.assign(env.stripe, savedEnv);
  Object.assign(emails, savedEmails);
  stripeClient._setClientForTests(null);
});

module.exports = done();

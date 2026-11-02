/**
 * Webhook verification helpers shipped by the foundation: DocuSign Connect
 * HMAC over raw bytes, Connect payload normalisation (dedupe id), package
 * extraction, Stripe signature verification (no network) and the invoice
 * shape helpers. The DocuSign / Stripe tracks extend these in their own
 * contract*.test.js files. No DB or network.
 */
const assert = require('assert');
const crypto = require('crypto');
const { t, group, done } = require('./contractHarness')(__filename);
const { verifyConnectHmac, normaliseConnectPayload, extractPackageChoice } = require('../contracts/docusign');
const billing = require('../contracts/billing');
const Stripe = require('stripe');

const sign = (key, buf) => crypto.createHmac('sha256', key).update(buf).digest('base64');
const body = Buffer.from(JSON.stringify({ event: 'envelope-completed', data: { envelopeId: 'env-1' } }));

group('verifyConnectHmac');
t('valid signature', () => {
  const r = verifyConnectHmac({ rawBody: body, headers: { 'x-docusign-signature-1': sign('k1', body) }, keys: ['k1'] });
  assert.strictEqual(r.ok, true);
});
t('wrong key → mismatch', () => {
  const r = verifyConnectHmac({ rawBody: body, headers: { 'x-docusign-signature-1': sign('nope', body) }, keys: ['k1'] });
  assert.deepStrictEqual(r, { ok: false, reason: 'mismatch' });
});
t('rotation: header 2 valid while header 1 is stale', () => {
  const r = verifyConnectHmac({
    rawBody: body,
    headers: { 'X-DocuSign-Signature-1': sign('old', body), 'X-DocuSign-Signature-2': sign('new', body) },
    keys: ['new'],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.header, 'X-DocuSign-Signature-2');
});
t('body changed by one byte → mismatch', () => {
  const tampered = Buffer.from(body);
  tampered[tampered.length - 2] ^= 1;
  const r = verifyConnectHmac({ rawBody: tampered, headers: { 'x-docusign-signature-1': sign('k1', body) }, keys: ['k1'] });
  assert.strictEqual(r.ok, false);
});
t('length mismatch, missing header, no keys, no body', () => {
  assert.strictEqual(verifyConnectHmac({ rawBody: body, headers: { 'x-docusign-signature-1': 'abc' }, keys: ['k1'] }).reason, 'mismatch');
  assert.strictEqual(verifyConnectHmac({ rawBody: body, headers: {}, keys: ['k1'] }).reason, 'no_signature');
  assert.strictEqual(verifyConnectHmac({ rawBody: body, headers: {}, keys: [] }).reason, 'no_keys');
  assert.strictEqual(verifyConnectHmac({ rawBody: undefined, headers: {}, keys: ['k1'] }).reason, 'no_body');
});

group('normaliseConnectPayload');
const payload = {
  event: 'envelope-completed',
  generatedDateTime: '2026-11-03T15:00:00.000Z',
  data: {
    accountId: 'acc-1',
    envelopeId: 'env-1',
    envelopeSummary: { status: 'completed', customFields: { textCustomFields: [{ name: 'contractId', value: 'c1' }] } },
  },
};
t('flattens the useful fields', () => {
  const n = normaliseConnectPayload(payload);
  assert.strictEqual(n.envelopeId, 'env-1');
  assert.strictEqual(n.accountId, 'acc-1');
  assert.strictEqual(n.status, 'completed');
  assert.strictEqual(n.contractId, 'c1');
  assert.match(n.eventId, /^[0-9a-f]{64}$/);
});
t('the same message always gets the same eventId; another event does not', () => {
  assert.strictEqual(normaliseConnectPayload(payload).eventId, normaliseConnectPayload(JSON.parse(JSON.stringify(payload))).eventId);
  assert.notStrictEqual(normaliseConnectPayload(payload).eventId, normaliseConnectPayload({ ...payload, event: 'envelope-sent' }).eventId);
});
t('garbage in → empty fields, no throw', () => {
  assert.strictEqual(normaliseConnectPayload(undefined).envelopeId, '');
});

group('extractPackageChoice');
const recipients = (sel, value) => ({
  signers: [
    {
      recipientId: '1',
      tabs: {
        radioGroupTabs: [
          {
            groupName: 'monitoringPackage',
            radios: [
              { value: 'basic', selected: sel === 'basic' ? 'true' : 'false' },
              { value: value || 'smart', selected: sel === 'smart' ? 'true' : 'false' },
            ],
          },
        ],
      },
    },
  ],
});
t('basic / smart from the radio tabs', () => {
  assert.deepStrictEqual(extractPackageChoice({ recipients: recipients('basic') }), { package: 'basic', source: 'tabs', raw: 'basic' });
  assert.strictEqual(extractPackageChoice({ recipients: recipients('smart') }).package, 'smart');
});
t('nothing selected → null', () => {
  assert.deepStrictEqual(extractPackageChoice({ recipients: recipients(null) }), { package: null, source: null, raw: null });
});
t('an unknown value is reported raw, not accepted', () => {
  const r = extractPackageChoice({ recipients: recipients('smart', 'premium') });
  assert.strictEqual(r.package, null);
  assert.strictEqual(r.raw, 'premium');
});
t('form_data fallback', () => {
  const r = extractPackageChoice({
    formData: { formData: [], recipientFormData: [{ recipientId: '1', formData: [{ name: 'monitoringPackage', value: 'smart' }] }] },
  });
  assert.deepStrictEqual(r, { package: 'smart', source: 'form_data', raw: 'smart' });
});

group('Stripe');
t('constructEvent verifies a locally signed payload (no network)', () => {
  const secret = 'whsec_test_123';
  const raw = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_1' } } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  const ev = Stripe.webhooks.constructEvent(Buffer.from(raw), header, secret);
  assert.strictEqual(ev.id, 'evt_1');
  assert.throws(() => Stripe.webhooks.constructEvent(Buffer.from(raw + ' '), header, secret));
});
t('subscription id from basil and legacy invoices', () => {
  assert.strictEqual(billing.getSubscriptionId({ parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_b' } } }), 'sub_b');
  assert.strictEqual(billing.getSubscriptionId({ subscription: 'sub_l' }), 'sub_l');
  assert.strictEqual(billing.getSubscriptionId({ subscription: { id: 'sub_o' } }), 'sub_o');
  assert.strictEqual(billing.getSubscriptionId({}), null);
});
t('period end from the item (basil) or top level (legacy)', () => {
  assert.strictEqual(billing.getPeriodEnd({ items: { data: [{ current_period_end: 1790000000 }] } }).getTime(), 1790000000000);
  assert.strictEqual(billing.getPeriodEnd({ current_period_end: 1790000001 }).getTime(), 1790000001000);
  assert.strictEqual(billing.getPeriodEnd({}), null);
});
t('paymentFromInvoice maps amounts, tax and the service period', () => {
  const p = billing.paymentFromInvoice({
    id: 'in_1',
    customer: 'cus_1',
    parent: { subscription_details: { subscription: 'sub_1' } },
    number: 'ABC-0001',
    status: 'paid',
    billing_reason: 'subscription_create',
    attempted: true,
    attempt_count: 1,
    subtotal: 3299,
    total: 3728,
    total_taxes: [{ amount: 429 }],
    amount_due: 3728,
    amount_paid: 3728,
    amount_remaining: 0,
    currency: 'cad',
    period_start: 1790000000,
    period_end: 1790000000,
    lines: { data: [{ period: { start: 1790000000, end: 1792600000 } }] },
    status_transitions: { paid_at: 1790000100 },
    hosted_invoice_url: 'https://invoice.stripe.com/i/x',
    invoice_pdf: 'https://pay.stripe.com/invoice/x/pdf',
  });
  assert.strictEqual(p.stripeSubscriptionId, 'sub_1');
  assert.strictEqual(p.taxCents, 429);
  assert.strictEqual(p.totalCents, 3728);
  assert.strictEqual(p.periodEnd.getTime(), 1792600000000);
  assert.strictEqual(p.paidAt.getTime(), 1790000100000);
  assert.strictEqual(p.missed, false);
});
t('legacy tax field', () => {
  assert.strictEqual(billing.getInvoiceTaxCents({ tax: 325 }), 325);
});
t('isMissed: attempted open with money owing, or uncollectible', () => {
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: true, amountRemainingCents: 3728 }), true);
  assert.strictEqual(billing.isMissed({ status: 'open', attempted: false, attemptCount: 0, amountRemainingCents: 3728 }), false);
  assert.strictEqual(billing.isMissed({ status: 'uncollectible', amountRemainingCents: 3728 }), true);
  assert.strictEqual(billing.isMissed({ status: 'uncollectible', amountRemainingCents: 0 }), false);
  assert.strictEqual(billing.isMissed({ status: 'paid', attempted: true, amountRemainingCents: 0 }), false);
});

module.exports = done();

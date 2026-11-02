/**
 * Contract state machine: status derivation, forward-only envelope ranks,
 * Stripe status mapping, action guards, the webhook dedupe decision and the
 * AlarmContract model helpers. No DB or network.
 */
const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const S = require('../contracts/status');
const { decideOnExisting, STALE_MS } = require('../contracts/webhookEvents');
const { lotActorFor, MILESTONE_TYPES } = require('../contracts/eventLogger');
const AlarmContract = require('../../models/AlarmContract');
const ContractDocument = require('../../models/ContractDocument');

const c = (envelopeStatus, billingStatus, extra = {}) => {
  const o = { envelope: { status: envelopeStatus }, billing: { status: billingStatus }, signingMode: 'remote', ...extra };
  o.status = S.deriveContractStatus(o);
  return o;
};

group('deriveContractStatus');
t('envelope half', () => {
  assert.strictEqual(S.deriveContractStatus({}), 'draft');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: null } }), 'draft');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'created' } }), 'draft');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'sent' } }), 'sent');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'delivered' } }), 'sent');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'declined' } }), 'declined');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'voided' } }), 'voided');
  assert.strictEqual(S.deriveContractStatus({ envelope: { status: 'completed' } }), 'awaiting_payment');
});
t('signed but not paying yet stays awaiting_payment', () => {
  for (const b of ['none', 'checkout_open', 'incomplete']) {
    assert.strictEqual(c('completed', b).status, 'awaiting_payment', b);
  }
});
t('billing half wins once a subscription exists', () => {
  assert.strictEqual(c('completed', 'active').status, 'active');
  assert.strictEqual(c('completed', 'past_due').status, 'past_due');
  assert.strictEqual(c('completed', 'unpaid').status, 'unpaid');
  assert.strictEqual(c('completed', 'canceled').status, 'canceled');
  assert.strictEqual(c('completed', 'incomplete_expired').status, 'canceled');
  assert.strictEqual(c('completed', 'paused').status, 'past_due');
});
t('every derived value is a known status with meta', () => {
  for (const e of [null, ...S.ENVELOPE_STATUSES]) {
    for (const b of S.BILLING_STATUSES) {
      const s = c(e, b).status;
      assert.ok(S.CONTRACT_STATUSES.includes(s), `${e}/${b} → ${s}`);
      assert.ok(S.CONTRACT_STATUS_META[s].label && S.CONTRACT_STATUS_META[s].badge);
    }
  }
});

group('envelope ranks (forward only)');
t('moves forward, never back', () => {
  assert.strictEqual(S.canAdvanceEnvelope(null, 'sent'), true);
  assert.strictEqual(S.canAdvanceEnvelope('sent', 'delivered'), true);
  assert.strictEqual(S.canAdvanceEnvelope('delivered', 'completed'), true);
  assert.strictEqual(S.canAdvanceEnvelope('delivered', 'sent'), false);
  assert.strictEqual(S.canAdvanceEnvelope('sent', 'sent'), false);
});
t('terminal states are final (a late delivered or a second terminal is ignored)', () => {
  assert.strictEqual(S.canAdvanceEnvelope('completed', 'delivered'), false);
  assert.strictEqual(S.canAdvanceEnvelope('completed', 'voided'), false);
  assert.strictEqual(S.canAdvanceEnvelope('declined', 'completed'), false);
});
t('unknown statuses never apply', () => {
  assert.strictEqual(S.canAdvanceEnvelope('sent', 'bogus'), false);
  assert.deepStrictEqual(S.envelopeStatusesBelow('bogus'), []);
});
t('envelopeStatusesBelow builds the compare-and-set filter', () => {
  assert.deepStrictEqual(S.envelopeStatusesBelow('delivered'), [null, 'created', 'sent']);
  assert.deepStrictEqual(S.envelopeStatusesBelow('completed'), [null, 'created', 'sent', 'delivered']);
  assert.ok(!S.envelopeStatusesBelow('voided').includes('completed'));
});

group('mapStripeSubStatus');
t('maps every Stripe subscription status', () => {
  assert.strictEqual(S.mapStripeSubStatus('trialing'), 'active');
  for (const s of ['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.strictEqual(S.mapStripeSubStatus(s), s);
    assert.ok(S.BILLING_STATUSES.includes(S.mapStripeSubStatus(s)));
  }
  assert.strictEqual(S.mapStripeSubStatus('something_new'), null);
});

group('action guards');
t('draft: edit / send / delete / paper upload only', () => {
  const d = c(null, 'none');
  for (const a of ['edit', 'send', 'delete', 'manual_signed']) assert.ok(S.canPerform(a, d), a);
  for (const a of ['resend', 'void', 'regenerate', 'cancel', 'checkout']) assert.ok(!S.canPerform(a, d), a);
});
t('paper drafts cannot be sent through DocuSign', () => {
  assert.strictEqual(S.canPerform('send', c(null, 'none', { signingMode: 'paper' })), false);
});
t('sent: resend (remote only) / void / signing view (in person only)', () => {
  assert.ok(S.canPerform('resend', c('sent', 'none')));
  assert.ok(!S.canPerform('resend', c('sent', 'none', { signingMode: 'in_person' })));
  assert.ok(S.canPerform('void', c('delivered', 'none')));
  assert.ok(S.canPerform('signing_view', c('sent', 'none', { signingMode: 'in_person' })));
  assert.ok(!S.canPerform('signing_view', c('sent', 'none')));
  assert.ok(!S.canPerform('edit', c('sent', 'none')));
});
t('regenerate only after decline / void / cancellation', () => {
  assert.ok(S.canPerform('regenerate', c('declined', 'none')));
  assert.ok(S.canPerform('regenerate', c('voided', 'none')));
  assert.ok(!S.canPerform('regenerate', c('completed', 'none')));
  assert.ok(S.canPerform('regenerate', c('completed', 'canceled')), 'a cancelled contract can be replaced');
  assert.ok(!S.canPerform('regenerate', c('completed', 'active')));
});
t('package_missing blocks checkout with its own code', () => {
  const pm = c('completed', 'none', { needsAttention: 'package_missing' });
  assert.ok(!S.canPerform('checkout', pm));
  assert.ok(S.canPerform('set_package', pm));
  assert.throws(() => S.assertCan('checkout', pm), (e) => e.code === 'package_missing' && e.status === 409);
});
t('checkout refused once a live subscription exists', () => {
  assert.ok(S.canPerform('checkout', c('completed', 'checkout_open')));
  const live = c('completed', 'incomplete', { billing: { status: 'incomplete', subscriptionId: 'sub_1' } });
  assert.ok(!S.canPerform('checkout', live));
});
t('cancel while billing, or signed with payment never set up', () => {
  for (const b of ['active', 'past_due', 'unpaid']) assert.ok(S.canPerform('cancel', c('completed', b)), b);
  assert.ok(S.canPerform('cancel', c('completed', 'none')), 'awaiting_payment can be closed out');
  assert.ok(S.canPerform('cancel', c('completed', 'checkout_open')));
  assert.ok(!S.canPerform('cancel', c('completed', 'canceled')));
  assert.ok(!S.canPerform('cancel', c('sent', 'none')));
});
t('purchaser contact can be corrected once signed, not before', () => {
  assert.ok(S.canPerform('update_contact', c('completed', 'none')));
  assert.ok(S.canPerform('update_contact', c('completed', 'active')));
  assert.ok(!S.canPerform('update_contact', c('completed', 'canceled')));
  assert.ok(!S.canPerform('update_contact', c('sent', 'none')));
});
t('sending a paper draft explains the upload path', () => {
  assert.throws(
    () => S.assertCan('send', { status: 'draft', signingMode: 'paper', envelope: {}, billing: {} }),
    (e) => e.code === 'invalid_state' && /paper contract/.test(e.message)
  );
});
t('assertCan throws invalid_state (409)', () => {
  assert.throws(() => S.assertCan('void', c(null, 'none')), (e) => e.code === 'invalid_state' && e.status === 409);
  assert.throws(() => S.canPerform('fly', c(null, 'none')), /Unknown contract action/);
});
t('lot reopen allowed only before a live contract', () => {
  assert.ok(S.canReopenLot(null));
  for (const s of ['draft', 'declined', 'voided']) assert.ok(S.canReopenLot(s), s);
  for (const s of ['sent', 'awaiting_payment', 'active', 'canceled']) assert.ok(!S.canReopenLot(s), s);
});

group('webhook dedupe decision');
t('new / processed / ignored / failed', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  assert.strictEqual(decideOnExisting(null, now), 'process');
  assert.strictEqual(decideOnExisting({ status: 'processed' }, now), 'duplicate');
  assert.strictEqual(decideOnExisting({ status: 'ignored' }, now), 'duplicate');
  assert.strictEqual(decideOnExisting({ status: 'failed' }, now), 'retry');
});
t('processing: 409 while fresh, retried once stale', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const fresh = { status: 'processing', startedAt: new Date(now.getTime() - 1000) };
  const stale = { status: 'processing', startedAt: new Date(now.getTime() - STALE_MS - 1) };
  assert.strictEqual(decideOnExisting(fresh, now), 'in_progress');
  assert.strictEqual(decideOnExisting(stale, now), 'retry');
});

group('event logger mapping');
t('contract actors collapse onto the lot timeline actors', () => {
  assert.strictEqual(lotActorFor('user'), 'user');
  assert.strictEqual(lotActorFor('docusign_poller'), 'docusign');
  assert.strictEqual(lotActorFor('stripe_reconciler'), 'stripe');
  assert.strictEqual(lotActorFor('reminder_worker'), 'contracts');
  assert.strictEqual(lotActorFor('homeowner'), 'contracts');
});
t('milestones are mirrored; chatter is not', () => {
  for (const m of ['sent', 'completed', 'paper_signed', 'declined', 'voided', 'activated', 'canceled']) assert.ok(MILESTONE_TYPES.has(m));
  for (const m of ['delivered', 'reminder_sent', 'payment_succeeded']) assert.ok(!MILESTONE_TYPES.has(m));
});

group('models (no DB)');
t('contract numbers look like GA-2026-00042', () => {
  assert.strictEqual(AlarmContract.formatNumber(42, new Date('2026-11-03T12:00:00Z')), 'GA-2026-00042');
});
t('a new contract validates and defaults to draft', () => {
  const doc = new AlarmContract({
    number: 'GA-2026-00001',
    project: '64b000000000000000000001',
    lot: '64b000000000000000000002',
    purchasers: [{ role: 'buyer', name: 'Jane', email: 'JANE@x.com' }],
  });
  assert.strictEqual(doc.validateSync(), undefined);
  assert.strictEqual(doc.status, 'draft');
  assert.strictEqual(doc.billing.status, 'none');
  assert.strictEqual(doc.purchasers[0].email, 'jane@x.com');
  assert.strictEqual(doc.reminders.enabled, true);
});
t('package and signing mode are enum-checked', () => {
  const doc = new AlarmContract({
    number: 'x',
    project: '64b000000000000000000001',
    lot: '64b000000000000000000002',
    package: 'premium',
    signingMode: 'fax',
  });
  const err = doc.validateSync();
  assert.ok(err.errors.package && err.errors.signingMode);
});
t('documents over 15 MB are rejected', () => {
  const big = new ContractDocument({
    contract: '64b000000000000000000001',
    kind: 'agreement_signed',
    data: Buffer.alloc(1),
    size: 16 * 1024 * 1024,
    sha256: 'x',
  });
  assert.ok(big.validateSync().errors.size);
});
t('the unique-per-envelope flag is set for the fixed kinds only', async () => {
  const mk = (kind) => new ContractDocument({ contract: '64b000000000000000000001', kind, data: Buffer.alloc(1), size: 1, sha256: 'x' });
  const other = mk('other');
  await other.validate(); // runs the pre('validate') hook, no DB needed
  assert.strictEqual(other.singleton, false);
  const signed = mk('agreement_signed');
  await signed.validate();
  assert.strictEqual(signed.singleton, true);
});

module.exports = done();

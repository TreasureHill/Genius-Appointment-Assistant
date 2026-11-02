/**
 * Monitoring prices: 13% HST added on top, rounded the way Stripe rounds a
 * one-line invoice. No DB or network.
 */
const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const pricing = require('../contracts/pricing');

group('quote');
t('basic: 2499 + 325 HST = 2824', () => {
  const q = pricing.quote('basic');
  assert.strictEqual(q.unitCents, 2499);
  assert.strictEqual(q.taxCents, 325);
  assert.strictEqual(q.totalCents, 2824);
  assert.strictEqual(q.taxBps, 1300);
  assert.strictEqual(q.currency, 'cad');
});
t('smart: 3299 + 429 HST = 3728', () => {
  const q = pricing.quote('smart');
  assert.strictEqual(q.unitCents, 3299);
  assert.strictEqual(q.taxCents, 429);
  assert.strictEqual(q.totalCents, 3728);
});
t('unknown packages are rejected with invalid_package', () => {
  for (const bad of ['premium', '', null, undefined, 'BASIC', 'toString']) {
    assert.throws(() => pricing.quote(bad), (e) => e.code === 'invalid_package' && e.status === 400);
    assert.strictEqual(pricing.isValidPackage(bad), false);
  }
});
t('pricingFor gives the stored subdocument shape', () => {
  assert.deepStrictEqual(pricing.pricingFor('smart'), {
    unitCents: 3299,
    taxBps: 1300,
    taxCents: 429,
    totalCents: 3728,
    currency: 'cad',
  });
});
t('allQuotes lists basic then smart', () => {
  assert.deepStrictEqual(
    pricing.allQuotes().map((q) => q.package),
    ['basic', 'smart']
  );
});
t('taxFor rounds half up to the cent', () => {
  assert.strictEqual(pricing.taxFor(2499), 325); // 324.87
  assert.strictEqual(pricing.taxFor(3299), 429); // 428.87
  assert.strictEqual(pricing.taxFor(50), 7); // 6.5 → 7
});
t('lookup keys match the Stripe bootstrap names', () => {
  assert.strictEqual(pricing.PACKAGES.basic.lookupKey, 'genius_monitoring_basic_monthly');
  assert.strictEqual(pricing.PACKAGES.smart.lookupKey, 'genius_monitoring_smart_monthly');
});

group('fmtCad / describeQuote');
t('formats cents as Canadian dollars', () => {
  assert.strictEqual(pricing.fmtCad(2824), '$28.24');
  assert.strictEqual(pricing.fmtCad(0), '$0.00');
  assert.strictEqual(pricing.fmtCad(123456), '$1,234.56');
});
t('blank for missing amounts', () => {
  assert.strictEqual(pricing.fmtCad(null), '');
  assert.strictEqual(pricing.fmtCad(undefined), '');
  assert.strictEqual(pricing.fmtCad('x'), '');
});
t('describeQuote spells out the HST', () => {
  assert.strictEqual(pricing.describeQuote('basic'), 'Basic Monitoring – $24.99/month + 13% HST ($3.25) = $28.24/month');
});

module.exports = done();

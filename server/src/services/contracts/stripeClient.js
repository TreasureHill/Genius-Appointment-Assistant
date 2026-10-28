const env = require('../../config/env');
const { contractError } = require('./errors');
const { PACKAGES, PACKAGE_KEYS, CURRENCY, HST_BPS } = require('./pricing');

// Stripe SDK wrapper: one lazy client with the pinned API version, price
// resolution by lookup_key, and the catalog gate that refuses checkout if
// Stripe's prices / tax rate disagree with services/contracts/pricing.js.
//
// Owner: Stripe track (tests: contractStripe.test.js). `stripe()`,
// `expectedLivemode()` and `dashboardUrl()` were shipped by the foundation.

let client = null;

/**
 * Lazy Stripe client, or null when STRIPE_SECRET_KEY is blank. Callers that
 * need it should use requireStripe().
 * @returns {import('stripe').Stripe|null}
 */
function stripe() {
  // `client` is only ever set while configured (or by _setClientForTests).
  if (client) return client;
  if (!env.stripe.configured) return null;
  {
    const Stripe = require('stripe');
    // Pinned API version (STRIPE_API_VERSION, else the SDK's own — env.js
    // fills it in). It must match the webhook endpoint's version so event
    // payloads have the shape the basil helpers below expect.
    client = new Stripe(env.stripe.secretKey, {
      apiVersion: env.stripe.apiVersion || undefined,
      maxNetworkRetries: 2,
      appInfo: { name: 'genius-appointment-assistant' },
    });
  }
  return client;
}

/** stripe() or throw contractError('not_configured'). */
function requireStripe() {
  const s = stripe();
  if (!s) throw contractError('not_configured', 'Stripe is not configured');
  return s;
}

/** true (live key) / false (test key) / null (not configured). Webhook livemode guard. */
function expectedLivemode() {
  if (env.stripe.mode === 'live') return true;
  if (env.stripe.mode === 'test') return false;
  return null;
}

/** "https://dashboard.stripe.com/test/customers/cus_…" for admin links. */
function dashboardUrl(path = '') {
  const base = env.stripe.mode === 'live' ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------
// Catalog: prices + the HST tax rate
// ---------------------------------------------------------------------------

// Prices barely ever change, but a wrong one means charging the wrong amount,
// so both caches are short. A failed catalog check is cached for a minute
// only, so fixing Stripe and clicking Settings → Stripe → Test (force) or just
// retrying a minute later unblocks checkout.
const PRICE_TTL_MS = 10 * 60 * 1000;
const CATALOG_OK_TTL_MS = 10 * 60 * 1000;
const CATALOG_FAIL_TTL_MS = 60 * 1000;
// Price tax_behavior is write-once in Stripe and only matters for Stripe Tax.
// We charge HST through a manual TaxRate (whose `inclusive` flag decides), so
// a price created by hand before the bootstrap ('unspecified') is fine.
const OK_TAX_BEHAVIORS = ['exclusive', 'unspecified', null, undefined];

let priceCache = null; // { at, prices }
let catalogCache = null; // { at, result }

const isMissingResource = (err) =>
  Boolean(err && (err.code === 'resource_missing' || err.statusCode === 404));

/**
 * Resolve the two monthly prices (env id overrides first, else
 * prices.list({lookup_keys}) — cached for the process; pass force to refresh).
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{basic: import('stripe').Stripe.Price, smart: import('stripe').Stripe.Price}>}
 * @throws not_configured | stripe_catalog_mismatch (a price is missing)
 */
async function resolvePrices({ force = false } = {}) {
  const s = requireStripe();
  if (!force && priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const overrides = { basic: env.stripe.priceBasic, smart: env.stripe.priceSmart };
  const prices = {};
  const problems = [];
  const byLookup = PACKAGE_KEYS.filter((k) => !overrides[k]);
  for (const k of PACKAGE_KEYS) {
    if (!overrides[k]) continue;
    try {
      prices[k] = await s.prices.retrieve(overrides[k]);
    } catch (err) {
      if (!isMissingResource(err)) throw err;
      problems.push(`${PACKAGES[k].label}: price ${overrides[k]} (STRIPE_PRICE_${k.toUpperCase()}) does not exist in this Stripe account/mode`);
    }
  }
  if (byLookup.length) {
    const list = await s.prices.list({ lookup_keys: byLookup.map((k) => PACKAGES[k].lookupKey), active: true, limit: 10 });
    for (const k of byLookup) {
      const found = (list.data || []).find((p) => p.lookup_key === PACKAGES[k].lookupKey);
      if (found) prices[k] = found;
      else problems.push(`${PACKAGES[k].label}: no active price with lookup_key ${PACKAGES[k].lookupKey} (run npm run stripe:bootstrap)`);
    }
  }
  if (problems.length) throw contractError('stripe_catalog_mismatch', problems.join('; '), { problems });
  priceCache = { at: Date.now(), prices };
  return prices;
}

/**
 * Pure: everything wrong with the catalog compared with pricing.js.
 * @param {{prices: {basic?: object, smart?: object}, taxRate?: object|null, taxRateId?: string, mode?: string}} a
 * @returns {string[]} empty when the catalog matches
 */
function catalogProblems({ prices = {}, taxRate = null, taxRateId = '', mode = '' }) {
  const problems = [];
  const live = mode === 'live' ? true : mode === 'test' ? false : null;
  for (const k of PACKAGE_KEYS) {
    const pkg = PACKAGES[k];
    const p = prices[k];
    if (!p) {
      problems.push(`${pkg.label}: price not found`);
      continue;
    }
    const name = `${pkg.label} (${p.id})`;
    if (!p.active) problems.push(`${name}: price is archived`);
    if (p.unit_amount !== pkg.unitCents) problems.push(`${name}: amount is ${p.unit_amount} cents, expected ${pkg.unitCents}`);
    if (String(p.currency || '').toLowerCase() !== CURRENCY) problems.push(`${name}: currency is ${p.currency}, expected ${CURRENCY}`);
    const r = p.recurring || {};
    if (p.type && p.type !== 'recurring') problems.push(`${name}: not a recurring price`);
    if (r.interval !== 'month' || Number(r.interval_count || 1) !== 1) {
      problems.push(`${name}: billing interval is ${r.interval_count || 1} ${r.interval || 'none'}, expected 1 month`);
    }
    if (r.usage_type && r.usage_type !== 'licensed') problems.push(`${name}: metered prices are not supported`);
    if (!OK_TAX_BEHAVIORS.includes(p.tax_behavior)) {
      problems.push(`${name}: tax_behavior is ${p.tax_behavior}, expected exclusive (HST is added on top)`);
    }
    if (live !== null && typeof p.livemode === 'boolean' && p.livemode !== live) {
      problems.push(`${name}: belongs to ${p.livemode ? 'live' : 'test'} mode but the key is ${mode}`);
    }
  }
  if (!taxRateId) {
    problems.push('STRIPE_TAX_RATE_ID is not set (run npm run stripe:bootstrap)');
  } else if (!taxRate) {
    problems.push(`Tax rate ${taxRateId} does not exist in this Stripe account/mode`);
  } else {
    // The real gate: 13% added on top, and still usable.
    if (Number(taxRate.percentage) !== HST_BPS / 100) problems.push(`Tax rate ${taxRateId}: ${taxRate.percentage}%, expected ${HST_BPS / 100}%`);
    if (taxRate.inclusive) problems.push(`Tax rate ${taxRateId}: is inclusive, expected exclusive (added on top)`);
    if (!taxRate.active) problems.push(`Tax rate ${taxRateId}: is archived`);
    if (live !== null && typeof taxRate.livemode === 'boolean' && taxRate.livemode !== live) {
      problems.push(`Tax rate ${taxRateId}: belongs to ${taxRate.livemode ? 'live' : 'test'} mode but the key is ${mode}`);
    }
  }
  return problems;
}

/**
 * Compare Stripe's catalog with pricing.js: each price unit_amount
 * (2499/3299), currency cad, recurring month, active, tax_behavior in
 * ['exclusive','unspecified']; tax rate STRIPE_TAX_RATE_ID percentage 13,
 * inclusive false, active; key livemode vs mode. Cached ~10 min.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, problems: string[], prices?: {basic: string, smart: string}, taxRateId?: string}>}
 *          Never throws for a mismatch (ok:false + problems); throws not_configured.
 */
async function verifyCatalog({ force = false } = {}) {
  const s = requireStripe();
  if (!force && catalogCache) {
    const ttl = catalogCache.result.ok ? CATALOG_OK_TTL_MS : CATALOG_FAIL_TTL_MS;
    if (Date.now() - catalogCache.at < ttl) return catalogCache.result;
  }
  let prices = {};
  const problems = [];
  try {
    prices = await resolvePrices({ force });
  } catch (err) {
    if (err.code !== 'stripe_catalog_mismatch') throw err;
    problems.push(...(err.problems || [err.message]));
  }
  const taxRateId = env.stripe.taxRateId;
  let taxRate = null;
  if (taxRateId) {
    try {
      taxRate = await s.taxRates.retrieve(taxRateId);
    } catch (err) {
      if (!isMissingResource(err)) throw err;
    }
  }
  // Missing prices were already reported by resolvePrices; only check the ones we have.
  const found = catalogProblems({ prices, taxRate, taxRateId, mode: env.stripe.mode }).filter(
    (p) => !/: price not found$/.test(p)
  );
  problems.push(...found);
  const result = { ok: problems.length === 0, problems };
  if (prices.basic && prices.smart) result.prices = { basic: prices.basic.id, smart: prices.smart.id };
  if (taxRateId) result.taxRateId = taxRateId;
  catalogCache = { at: Date.now(), result };
  return result;
}

/**
 * verifyCatalog() or throw contractError('stripe_catalog_mismatch', …, {problems}).
 * @returns {Promise<{prices: {basic: string, smart: string}, taxRateId: string}>}
 */
async function assertCatalog() {
  const r = await verifyCatalog();
  if (!r.ok || !r.prices || !r.taxRateId) {
    const problems = r.problems.length ? r.problems : ['Stripe catalog is incomplete'];
    throw contractError('stripe_catalog_mismatch', 'Online payment is temporarily unavailable (Stripe catalog check failed)', {
      problems,
    });
  }
  return { prices: r.prices, taxRateId: r.taxRateId };
}

// Stripe error text is shown in Settings. Stripe already masks keys in its
// messages, but scrub anything key-shaped anyway.
function safeStripeMessage(err) {
  if (err && err.type === 'StripeAuthenticationError') return 'Stripe rejected the API key (check STRIPE_SECRET_KEY)';
  if (err && err.type === 'StripePermissionError') return 'The Stripe key lacks permission for prices / tax rates';
  if (err && err.type === 'StripeConnectionError') return 'Could not reach Stripe';
  return String((err && err.message) || 'Stripe request failed').replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, '[redacted]');
}

/**
 * Health for Settings → Stripe → Test. Never throws.
 * @returns {Promise<{ok: boolean, message: string, mode: 'test'|'live'|'', catalogOk: boolean, problems: string[]}>}
 */
async function verifyStripe() {
  if (!env.stripe.configured) return { ok: false, message: 'Stripe not configured', mode: '', catalogOk: false, problems: [] };
  const mode = env.stripe.mode;
  try {
    // A forced catalog check is also the auth check: it lists prices and
    // retrieves the tax rate with the key.
    const r = await verifyCatalog({ force: true });
    const notes = [];
    if (!env.stripe.webhookSecret) notes.push('STRIPE_WEBHOOK_SECRET is not set');
    if (r.ok) {
      return {
        ok: true,
        message: `Connected (${mode || 'unknown'} mode); catalog matches${notes.length ? `; ${notes.join('; ')}` : ''}`,
        mode,
        catalogOk: true,
        problems: [],
      };
    }
    return {
      ok: false,
      message: `Connected (${mode || 'unknown'} mode) but the catalog does not match: ${r.problems.join('; ')}`,
      mode,
      catalogOk: false,
      problems: r.problems,
    };
  } catch (err) {
    return { ok: false, message: safeStripeMessage(err), mode, catalogOk: false, problems: [] };
  }
}

// Tests only: inject a fake client (or null to go back to the real one) and
// drop the caches.
function _setClientForTests(fake) {
  client = fake || null;
  priceCache = null;
  catalogCache = null;
}

module.exports = {
  stripe,
  requireStripe,
  expectedLivemode,
  dashboardUrl,
  resolvePrices,
  verifyCatalog,
  assertCatalog,
  verifyStripe,
  catalogProblems,
  safeStripeMessage,
  _setClientForTests,
};

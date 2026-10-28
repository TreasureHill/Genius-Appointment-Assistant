/**
 * One-time Stripe catalog setup for alarm monitoring (run once per mode, test
 * and live):  npm run stripe:bootstrap -w server
 *
 * Idempotently finds-or-creates:
 *  - the two products (metadata.package basic|smart)
 *  - the monthly CAD prices by lookup_key (pricing.PACKAGES[*].lookupKey,
 *    unit_amount from pricing.js, tax_behavior 'exclusive')
 *  - the 13% Ontario HST tax rate (exclusive, CA/ON, tax_type 'hst',
 *    metadata.genius_key 'hst_on_13')
 * and prints the ids to paste into .env (STRIPE_TAX_RATE_ID, optional
 * STRIPE_PRICE_BASIC / STRIPE_PRICE_SMART). Never prints the secret key.
 *
 * Running it again changes nothing. If a price behind a lookup_key has the
 * wrong amount (pricing.js changed), a new price is created and the lookup_key
 * moved onto it (transfer_lookup_key) — Stripe prices are immutable, and
 * existing subscriptions keep their old price until changed by hand.
 *
 * Owner: Stripe track.
 */
const env = require('../config/env');
const { PACKAGES, PACKAGE_KEYS, CURRENCY, HST_BPS } = require('../services/contracts/pricing');
const { requireStripe, catalogProblems } = require('../services/contracts/stripeClient');

const TAX_RATE_KEY = 'hst_on_13';
const PRODUCT_NAMES = {
  basic: 'Genius Alarm Monitoring – Basic',
  smart: 'Genius Alarm Monitoring – Smart',
};

const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

async function findProduct(s, key) {
  for await (const p of s.products.list({ active: true, limit: 100 })) {
    if (p.metadata && p.metadata.package === key && p.metadata.genius === 'alarm_monitoring') return p;
  }
  return null;
}

async function ensurePrice(s, key, log) {
  const pkg = PACKAGES[key];
  const found = await s.prices.list({ lookup_keys: [pkg.lookupKey], limit: 1 });
  const existing = found.data && found.data[0];
  const wanted = (p) =>
    p.active &&
    p.unit_amount === pkg.unitCents &&
    p.currency === CURRENCY &&
    p.recurring &&
    p.recurring.interval === 'month' &&
    Number(p.recurring.interval_count || 1) === 1;
  if (existing && wanted(existing)) {
    log(`price ${pkg.lookupKey}: found ${existing.id}`);
    return { product: idOf(existing.product), price: existing.id };
  }
  let product = existing ? idOf(existing.product) : null;
  if (!product) {
    const p = await findProduct(s, key);
    if (p) {
      product = p.id;
      log(`product ${key}: found ${product}`);
    } else {
      const created = await s.products.create(
        { name: PRODUCT_NAMES[key], description: pkg.desc, metadata: { package: key, genius: 'alarm_monitoring' } },
        { idempotencyKey: `genius-product-${key}-${env.stripe.mode}` }
      );
      product = created.id;
      log(`product ${key}: created ${product}`);
    }
  }
  const price = await s.prices.create({
    product,
    currency: CURRENCY,
    unit_amount: pkg.unitCents,
    recurring: { interval: 'month', interval_count: 1 },
    lookup_key: pkg.lookupKey,
    // Moves the lookup_key off a wrong/archived price, if there is one.
    transfer_lookup_key: Boolean(existing),
    tax_behavior: 'exclusive',
    nickname: `${pkg.label} monthly`,
    metadata: { package: key },
  });
  log(`price ${pkg.lookupKey}: ${existing ? `replaced ${existing.id} with` : 'created'} ${price.id}`);
  return { product, price: price.id };
}

async function ensureTaxRate(s, log) {
  const good = (r) => r.active && Number(r.percentage) === HST_BPS / 100 && !r.inclusive;
  if (env.stripe.taxRateId) {
    try {
      const r = await s.taxRates.retrieve(env.stripe.taxRateId);
      if (good(r)) {
        log(`tax rate: STRIPE_TAX_RATE_ID ${r.id} is fine`);
        return r.id;
      }
      log(`tax rate: STRIPE_TAX_RATE_ID ${r.id} is not an active exclusive 13% rate; looking for another`);
    } catch {
      log(`tax rate: STRIPE_TAX_RATE_ID ${env.stripe.taxRateId} not found in this mode; looking for another`);
    }
  }
  for await (const r of s.taxRates.list({ active: true, limit: 100 })) {
    if (r.metadata && r.metadata.genius_key === TAX_RATE_KEY && good(r)) {
      log(`tax rate: found ${r.id}`);
      return r.id;
    }
  }
  const r = await s.taxRates.create(
    {
      display_name: 'HST',
      description: 'Ontario HST 13%',
      percentage: HST_BPS / 100,
      inclusive: false,
      active: true,
      country: 'CA',
      state: 'ON',
      jurisdiction: 'Ontario',
      tax_type: 'hst',
      metadata: { genius_key: TAX_RATE_KEY },
    },
    { idempotencyKey: `genius-tax-${TAX_RATE_KEY}-${env.stripe.mode}` }
  );
  log(`tax rate: created ${r.id}`);
  return r.id;
}

/**
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {Promise<{products: {basic: string, smart: string}, prices: {basic: string, smart: string}, taxRateId: string, mode: string}>}
 */
async function bootstrap({ log = () => {} } = {}) {
  const s = requireStripe();
  const products = {};
  const prices = {};
  for (const key of PACKAGE_KEYS) {
    const r = await ensurePrice(s, key, log);
    products[key] = r.product;
    prices[key] = r.price;
  }
  const taxRateId = await ensureTaxRate(s, log);
  // Same check checkout runs, as a final sanity pass.
  const [basic, smart, taxRate] = await Promise.all([
    s.prices.retrieve(prices.basic),
    s.prices.retrieve(prices.smart),
    s.taxRates.retrieve(taxRateId),
  ]);
  const problems = catalogProblems({ prices: { basic, smart }, taxRate, taxRateId, mode: env.stripe.mode });
  if (problems.length) log(`WARNING: catalog check still reports: ${problems.join('; ')}`);
  return { products, prices, taxRateId, mode: env.stripe.mode };
}

module.exports = { bootstrap };

if (require.main === module) {
  if (!env.stripe.configured) {
    console.error('STRIPE_SECRET_KEY is not set in .env');
    process.exit(1);
  }
  console.log(`Stripe bootstrap (${env.stripe.mode || 'unknown'} mode)`);
  bootstrap({ log: (l) => console.log(`  ${l}`) })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      console.log('\nAdd to .env:');
      console.log(`STRIPE_TAX_RATE_ID=${r.taxRateId}`);
      console.log(`# optional (lookup_key is used when blank):`);
      console.log(`# STRIPE_PRICE_BASIC=${r.prices.basic}`);
      console.log(`# STRIPE_PRICE_SMART=${r.prices.smart}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

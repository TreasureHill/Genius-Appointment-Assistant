// Monitoring prices — the single source of truth for the agreement PDF, the
// emails, the API and the Stripe catalog check (stripeClient.verifyCatalog
// refuses checkout if Stripe disagrees with these numbers). Pure: no DB, no
// network, safe to require from tests.
//
// Ontario HST (13%) is added on top of the package price. Tax is rounded per
// line the same way Stripe rounds a single-line invoice, so what we quote is
// what Stripe charges:
//   Basic: 2499 + 325 = 2824  ($28.24)
//   Smart: 3299 + 429 = 3728  ($37.28)

const HST_BPS = 1300; // basis points: 1300 = 13.00%
const CURRENCY = 'cad';

const PACKAGES = Object.freeze({
  basic: Object.freeze({
    key: 'basic',
    label: 'Basic Monitoring',
    desc: 'Monitoring, no app functionality',
    unitCents: 2499,
    // Stripe Price lookup_key (scripts/stripeBootstrap.js creates it).
    lookupKey: 'genius_monitoring_basic_monthly',
  }),
  smart: Object.freeze({
    key: 'smart',
    label: 'Smart Monitoring',
    desc: 'Monitoring + mobile app control & notifications',
    unitCents: 3299,
    lookupKey: 'genius_monitoring_smart_monthly',
  }),
});

const PACKAGE_KEYS = Object.freeze(Object.keys(PACKAGES));

function isValidPackage(pkg) {
  return typeof pkg === 'string' && Object.prototype.hasOwnProperty.call(PACKAGES, pkg);
}

// Tax on a pre-tax amount, rounded half-up to the cent.
function taxFor(unitCents, bps = HST_BPS) {
  return Math.round((Number(unitCents) * bps) / 10000);
}

function invalidPackage(pkg) {
  const err = new Error(`Unknown monitoring package "${pkg}"`);
  err.code = 'invalid_package';
  err.status = 400;
  return err;
}

// Full price breakdown for a package. Throws err.code='invalid_package'.
function quote(pkg) {
  if (!isValidPackage(pkg)) throw invalidPackage(pkg);
  const p = PACKAGES[pkg];
  const taxCents = taxFor(p.unitCents);
  return {
    package: p.key,
    label: p.label,
    desc: p.desc,
    unitCents: p.unitCents,
    taxBps: HST_BPS,
    taxCents,
    totalCents: p.unitCents + taxCents,
    currency: CURRENCY,
  };
}

// The `pricing` subdocument stored on AlarmContract once the package is known.
function pricingFor(pkg) {
  const q = quote(pkg);
  return {
    unitCents: q.unitCents,
    taxBps: q.taxBps,
    taxCents: q.taxCents,
    totalCents: q.totalCents,
    currency: q.currency,
  };
}

// Both packages, in display order (Settings price table, portal, API).
function allQuotes() {
  return PACKAGE_KEYS.map(quote);
}

const cadFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

// 2824 → "$28.24". Blank for null / non-numbers so templates can print it
// unguarded.
function fmtCad(cents) {
  if (cents == null || cents === '' || !Number.isFinite(Number(cents))) return '';
  return cadFormat.format(Number(cents) / 100);
}

// "Smart Monitoring – $32.99/month + 13% HST ($4.29) = $37.28/month"
function describeQuote(pkg) {
  const q = quote(pkg);
  return `${q.label} – ${fmtCad(q.unitCents)}/month + ${q.taxBps / 100}% HST (${fmtCad(q.taxCents)}) = ${fmtCad(
    q.totalCents
  )}/month`;
}

module.exports = {
  HST_BPS,
  CURRENCY,
  PACKAGES,
  PACKAGE_KEYS,
  isValidPackage,
  taxFor,
  quote,
  pricingFor,
  allQuotes,
  fmtCad,
  describeQuote,
};

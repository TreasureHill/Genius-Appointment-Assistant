const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const toInt = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v, d = false) => {
  if (v == null) return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
const list = (v) =>
  String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// The DocuSign RSA private key: inline PEM (with \n escapes, as .env files
// can't hold newlines) or a path to a PEM file kept OUTSIDE the repo dir
// (deploy.ps1 re-clones / resets it). A missing file only warns: the server
// must boot without DocuSign.
function loadPrivateKey() {
  const inline = process.env.DOCUSIGN_PRIVATE_KEY || '';
  if (inline) return inline.replace(/\\n/g, '\n');
  const p = process.env.DOCUSIGN_PRIVATE_KEY_PATH || '';
  if (!p) return '';
  try {
    return fs.readFileSync(path.resolve(p), 'utf8');
  } catch (e) {
    console.warn(`[env] DOCUSIGN_PRIVATE_KEY_PATH could not be read (${e.code || 'error'}) — DocuSign disabled`);
    return '';
  }
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 4000),
  // Interface to listen on. Blank = all interfaces (dev, LAN testing). In
  // production behind Caddy on the same box set 127.0.0.1 (deploy.ps1 does):
  // with `trust proxy 1`, a client reaching :4000 directly could otherwise
  // pick its own X-Forwarded-For and dodge the per-IP login rate limits.
  host: (process.env.HOST || '').trim(),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/genius',
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  cookieSecure: toBool(process.env.COOKIE_SECURE, false),
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'changeme',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    secure: toBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },
  calendly: {
    token: process.env.CALENDLY_TOKEN || '',
    orgUri: process.env.CALENDLY_ORG_URI || '',
    // Optional fallback for the owner's Calendly user URI. Normally set in
    // Settings → Owner, but having an env fallback lets the reconcile script
    // run headless (e.g. in CI / a cron box) without the DB setting.
    userUri: process.env.CALENDLY_USER_URI || '',
    webhookSecret: process.env.CALENDLY_WEBHOOK_SECRET || '',
    // The Calendly Event Type Aria offers over the phone. Used to look up
    // real availability (event_type_available_times) and to mint the
    // scheduling link we text/email the homeowner to confirm. Normally set
    // in Settings → Aria; env is a fallback for headless runs.
    eventTypeUri: process.env.CALENDLY_EVENT_TYPE_URI || '',
  },
  // ElevenLabs Conversational AI ("Aria"). ElevenLabs places the outbound
  // call through their managed Twilio integration, so we don't need the
  // Twilio SDK for voice dispatch. The post-call webhook (transcript,
  // summary, recording) is HMAC-verified with webhookSecret.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
    agentPhoneNumberId: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || '',
    webhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || '',
  },
  // Shared secret the ElevenLabs agent presents (x-aria-secret header) when
  // it calls our server tools mid-conversation to read Calendly availability
  // and book a slot. Leave blank to accept unsigned tool calls (dev only).
  aria: {
    toolSecret: process.env.ARIA_TOOL_SECRET || '',
  },
  // Google reviews (Reviews tab). The SerpApi key can also be pasted into
  // the Reviews tab itself (stored in Settings); this is the headless fallback.
  reviews: {
    serpapiKey: process.env.SERPAPI_KEY || '',
    placeId: process.env.GOOGLE_PLACE_ID || '',
  },
  // Homeowner portal (/portal). Sessions are signed with their own secret so a
  // portal token can never verify as an admin token. Blank = derived from
  // JWT_SECRET (below).
  portal: {
    jwtSecret: process.env.PORTAL_JWT_SECRET || '',
    jwtSecretDerived: false,
  },
  // Printed on receipts / upcoming-invoice emails. Also set it in Stripe's
  // invoice settings.
  hst: {
    registrationNumber: process.env.HST_REGISTRATION_NUMBER || '',
  },
  // Stripe — monthly monitoring subscriptions via hosted Checkout. Prices live
  // in code (services/contracts/pricing.js) and are resolved in Stripe by
  // lookup_key unless overridden here.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    taxRateId: process.env.STRIPE_TAX_RATE_ID || '',
    priceBasic: process.env.STRIPE_PRICE_BASIC || '',
    priceSmart: process.env.STRIPE_PRICE_SMART || '',
    // Pinned API version. Must match the webhook endpoint's version in the
    // Stripe dashboard. Blank = the version the installed SDK ships with.
    apiVersion: process.env.STRIPE_API_VERSION || '',
    // Dev only: attach new customers to a Stripe test clock.
    testClocks: toBool(process.env.STRIPE_TEST_CLOCKS, false),
  },
  // DocuSign eSignature (JWT grant, no SDK). Envelope status arrives by
  // per-envelope Connect webhook, with a poller as fallback.
  docusign: {
    env: (process.env.DOCUSIGN_ENV || 'demo').toLowerCase() === 'prod' ? 'prod' : 'demo',
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY || '',
    userId: process.env.DOCUSIGN_USER_ID || '',
    accountId: process.env.DOCUSIGN_ACCOUNT_ID || '',
    privateKey: loadPrivateKey(),
    privateKeyPath: process.env.DOCUSIGN_PRIVATE_KEY_PATH || '',
    connectHmacKeys: list(process.env.DOCUSIGN_CONNECT_HMAC_KEYS),
    redirectUri: process.env.DOCUSIGN_REDIRECT_URI || '',
  },
  defaults: {
    pacingMin: toInt(process.env.DEFAULT_PACING_MIN_SEC, 30),
    pacingMax: toInt(process.env.DEFAULT_PACING_MAX_SEC, 120),
    reminderDays: toInt(process.env.DEFAULT_REMINDER_DAYS, 14),
    maxReminders: toInt(process.env.DEFAULT_MAX_REMINDERS, 3),
  },
};

env.smtp.configured = Boolean(env.smtp.host && env.smtp.from);
env.twilio.configured = Boolean(env.twilio.sid && env.twilio.token && env.twilio.from);
env.calendly.configured = Boolean(env.calendly.token);
// `configured` = we can talk to the API at all (used for health display).
// `dispatchable` = we have everything needed to actually place a call.
env.elevenlabs.configured = Boolean(env.elevenlabs.apiKey);
env.elevenlabs.dispatchable = Boolean(
  env.elevenlabs.apiKey && env.elevenlabs.agentId && env.elevenlabs.agentPhoneNumberId
);

env.isProduction = env.nodeEnv === 'production';
env.appUrl = trimSlash(env.appUrl);

// Portal secret: explicit, or HMAC(jwtSecret, 'portal') so it is always
// different from the admin secret without another variable to manage.
if (!env.portal.jwtSecret) {
  env.portal.jwtSecret = crypto.createHmac('sha256', env.jwtSecret).update('portal').digest('hex');
  env.portal.jwtSecretDerived = true;
}

// Stripe. mode comes from the key prefix (sk_test_/rk_test_ vs sk_live_/rk_live_);
// the webhook route rejects events whose livemode disagrees.
{
  const k = env.stripe.secretKey;
  env.stripe.mode = /^(sk|rk)_live_/.test(k) ? 'live' : /^(sk|rk)_test_/.test(k) ? 'test' : '';
  if (!env.stripe.apiVersion) {
    try {
      env.stripe.apiVersion = require('stripe').API_VERSION || '';
    } catch {
      env.stripe.apiVersion = '';
    }
  }
  // `configured` = we can call the API at all (health, reconcile).
  // `billable` = we can also open a Checkout (needs the HST tax rate).
  // `webhookConfigured` = incoming webhooks can be verified.
  env.stripe.configured = Boolean(k);
  env.stripe.billable = Boolean(k && env.stripe.taxRateId);
  env.stripe.webhookConfigured = Boolean(env.stripe.webhookSecret);
}

// DocuSign.
{
  const d = env.docusign;
  d.authHost = d.env === 'prod' ? 'account.docusign.com' : 'account-d.docusign.com';
  if (!d.redirectUri) d.redirectUri = `${env.appUrl}/settings`;
  // `configured` = we can get a JWT access token (health, refresh, poller).
  // `dispatchable` = we can create envelopes. Same requirements today; kept
  // separate (like ElevenLabs) so the UI can grow extra prerequisites.
  // `connectEnabled` = DocuSign can reach and sign our Connect webhook (public
  // https APP_URL + an HMAC key). Without it envelopes are created with no
  // eventNotification and the poller is the only status path.
  d.configured = Boolean(d.integrationKey && d.userId && d.privateKey);
  d.dispatchable = d.configured;
  d.connectEnabled = Boolean(d.connectHmacKeys.length && env.appUrl.startsWith('https://'));
  d.consentUrl = d.integrationKey
    ? `https://${d.authHost}/oauth/auth?response_type=code&scope=${encodeURIComponent(
        'signature impersonation'
      )}&client_id=${encodeURIComponent(d.integrationKey)}&redirect_uri=${encodeURIComponent(d.redirectUri)}`
    : '';
}

// Boot-time refusals. Pure so tests can exercise it; applied below.
function secretProblems({ nodeEnv, jwtSecret, portalSecret }) {
  const problems = [];
  if (nodeEnv === 'production' && (!jwtSecret || jwtSecret === DEFAULT_JWT_SECRET)) {
    problems.push('JWT_SECRET is unset or the insecure default — set a long random value in .env');
  }
  if (portalSecret && portalSecret === jwtSecret) {
    problems.push('PORTAL_JWT_SECRET must differ from JWT_SECRET (or be left blank to derive it)');
  }
  return problems;
}
env.secretProblems = secretProblems;
env.DEFAULT_JWT_SECRET = DEFAULT_JWT_SECRET;

{
  const problems = secretProblems({ nodeEnv: env.nodeEnv, jwtSecret: env.jwtSecret, portalSecret: env.portal.jwtSecret });
  if (problems.length) {
    throw new Error(`[env] refusing to start:\n  - ${problems.join('\n  - ')}`);
  }
  if (env.isProduction && !env.appUrl.startsWith('https://')) {
    console.warn('[env] APP_URL is not https — portal links and the DocuSign webhook need a public https URL');
  }
}

module.exports = env;

const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const AlarmContract = require('../models/AlarmContract');
const ContractPayment = require('../models/ContractPayment');
const ContractDocument = require('../models/ContractDocument');
const PortalUser = require('../models/PortalUser');
const Setting = require('../models/Setting');
const { requirePortalAuth, startPortalSession, clearPortalCookie } = require('../middleware/portalAuth');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const { httpErrorFor, contractError } = require('../services/contracts/errors');
const { PACKAGES } = require('../services/contracts/pricing');
const { canPerform, CONTRACT_STATUS_META } = require('../services/contracts/status');
const portalTokens = require('../services/contracts/portalTokens');
const emails = require('../services/contracts/emails');
const billing = require('../services/contracts/billing');
const { logContractEvent } = require('../services/contracts/eventLogger');

// Homeowner portal API, mounted at /api/portal BEFORE the admin requireAuth
// wall. Public auth routes (rate limited per IP and per email) and protected
// routes behind middleware/portalAuth.requirePortalAuth (req.portalUser).
// Every :id is scoped to req.portalUser.contracts — anything else is a 404.
//
// Owner: portal track. Endpoints (plan "Routes"): POST /auth/login,
// /auth/set-password, /auth/forgot, /auth/reset, /auth/logout,
// /auth/token-info (POST, token in the body); GET /me, GET /contracts/:id,
// POST /contracts/:id/checkout, POST /contracts/:id/billing-portal,
// GET /contracts/:id/checkout-status, GET /contracts/:id/documents/:kind,
// PATCH /contracts/:id/reminders.
//
// What a homeowner never sees: Stripe / DocuSign ids, staff notes, other
// purchasers' email addresses or phone numbers, event history, unsigned
// drafts. Responses are built field by field (publicContract) rather than by
// stripping a full document, so a new model field can't leak by accident.
const router = express.Router();

// Homeowners get our wording, never an upstream one: an error without a known
// code (a Stripe "No such customer: 'cus_…'", a raw Mongo error) becomes a
// generic message here. The full text still reaches the server log.
function sendError(res, err) {
  const { status, body } = httpErrorFor(err);
  if (status >= 500) console.error('[portal]', body.error, err && err.message);
  if (body.error === 'upstream_error') {
    body.message = 'Something went wrong on our side. Please try again in a few minutes.';
  }
  return res.status(status).json(body);
}

// Login CSRF guard. The app's global urlencoded parser would happily read a
// cross-site <form method=POST> to /auth/login and set the psid cookie for an
// attacker's account (SameSite=Lax limits sending cookies, not setting them).
// Our client only ever sends JSON or no body at all, and a cross-site page
// can't send JSON without a CORS preflight we refuse, so any other body type
// on a state-changing request is rejected outright.
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['content-type'] && !req.is('application/json')) {
    return res.status(415).json({ error: 'unsupported_media_type', message: 'Send the request as JSON.' });
  }
  return next();
});

// ---------------------------------------------------------------------------
// Rate limits + lockout
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

const normEmail = (e) => String(e || '').trim().toLowerCase();
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

const tooMany = (req, res) => res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' });

// Per client IP (trust proxy 1 → the real client behind Caddy).
const ipLimiter = (max) =>
  rateLimit({ windowMs: WINDOW_MS, max, standardHeaders: true, legacyHeaders: false, handler: tooMany });

// Per email address, so credential stuffing spread over many IPs still hits a
// wall. Requests without an email fall through to the IP limiter only.
const emailLimiter = (max, { onlyFailures = false } = {}) =>
  rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => `email:${normEmail(req.body && req.body.email)}`,
    skip: (req) => !normEmail(req.body && req.body.email),
    // Login counts failures only: otherwise anyone who knows a homeowner's
    // email could spend the budget and keep the real owner out.
    skipSuccessfulRequests: Boolean(onlyFailures),
    handler: tooMany,
  });

const loginLimits = [ipLimiter(20), emailLimiter(10, { onlyFailures: true })];
const forgotLimits = [ipLimiter(5), emailLimiter(3)];
const tokenLimits = [ipLimiter(30)];

// bcrypt.compare against this when the email is unknown, so a missing account
// takes as long to reject as a wrong password (no timing oracle).
let dummyHashPromise = null;
const dummyHash = () => {
  if (!dummyHashPromise) dummyHashPromise = portalTokens.hashPassword('not-a-real-password-xx');
  return dummyHashPromise;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported as router.helpers for tests)
// ---------------------------------------------------------------------------

const idStr = (v) => String((v && v._id) || v || '');

/** Is `id` one of this portal user's contracts? Invalid ids are simply "no". */
function ownsContract(user, id) {
  const s = String(id || '');
  if (!user || !mongoose.Types.ObjectId.isValid(s) || !/^[a-f0-9]{24}$/i.test(s)) return false;
  return (user.contracts || []).some((c) => idStr(c) === s.toLowerCase());
}

// Only these two documents are ever served to a homeowner.
const PORTAL_DOCUMENT_KINDS = Object.freeze({
  agreement_signed: { ref: 'signed', suffix: 'signed' },
  certificate: { ref: 'certificate', suffix: 'certificate' },
});
const isPortalDocumentKind = (kind) => Object.prototype.hasOwnProperty.call(PORTAL_DOCUMENT_KINDS, kind);

// Where to send someone right after they set a password or log in: the pay
// page of the first contract still waiting for its first payment.
function nextPathFor(contracts) {
  const c = (contracts || []).find((x) => x && canPerform('checkout', x));
  return c ? `/portal/pay?contract=${idStr(c)}` : '/portal';
}

function contractSummary(c) {
  const b = c.billing || {};
  return {
    id: idStr(c),
    number: c.number,
    status: c.status,
    statusLabel: (CONTRACT_STATUS_META[c.status] || {}).label || c.status,
    package: c.package || null,
    packageLabel: c.package && PACKAGES[c.package] ? PACKAGES[c.package].label : '',
    pricing: c.pricing && c.pricing.totalCents != null
      ? { unitCents: c.pricing.unitCents, taxBps: c.pricing.taxBps, taxCents: c.pricing.taxCents, totalCents: c.pricing.totalCents, currency: c.pricing.currency }
      : null,
    property: {
      projectName: (c.property && c.property.projectName) || '',
      model: (c.property && c.property.model) || '',
      lotNumber: (c.property && c.property.lotNumber) || '',
      address: (c.property && c.property.address) || '',
    },
    needsAttention: c.needsAttention || '',
    signedAt: c.signedAt || null,
    nextChargeAt: ['active', 'past_due'].includes(c.status) && !b.cancelAtPeriodEnd ? b.currentPeriodEnd || null : null,
  };
}

function publicPayment(p) {
  return {
    id: idStr(p),
    number: p.number || '',
    status: p.status,
    missed: Boolean(p.missed),
    periodStart: p.periodStart || null,
    periodEnd: p.periodEnd || null,
    createdAt: p.invoiceCreatedAt || null,
    paidAt: p.paidAt || null,
    subtotalCents: p.subtotalCents,
    taxCents: p.taxCents,
    totalCents: p.totalCents,
    amountPaidCents: p.amountPaidCents,
    amountRemainingCents: p.amountRemainingCents,
    amountRefundedCents: p.amountRefundedCents || 0,
    nextPaymentAttempt: p.nextPaymentAttempt || null,
    hostedInvoiceUrl: p.hostedInvoiceUrl || '',
    invoicePdfUrl: p.invoicePdfUrl || '',
  };
}

/** The homeowner-safe view of one contract (pure). */
function publicContract(c, { payments = [], documents = [], setting = null } = {}) {
  const b = c.billing || {};
  const alarm = (setting && setting.alarm) || {};
  return {
    ...contractSummary(c),
    signingMode: c.signingMode,
    // Names and roles only: a co-buyer's contact details aren't this user's to see.
    purchasers: (c.purchasers || []).map((p) => ({ role: p.role, name: p.name })),
    billing: {
      status: b.status || 'none',
      startedAt: b.startedAt || null,
      currentPeriodStart: b.currentPeriodStart || null,
      currentPeriodEnd: b.currentPeriodEnd || null,
      cancelAtPeriodEnd: Boolean(b.cancelAtPeriodEnd),
      canceledAt: b.canceledAt || null,
      endedAt: b.endedAt || null,
      card: b.pmLast4 ? { brand: b.pmBrand || '', last4: b.pmLast4, expMonth: b.pmExpMonth, expYear: b.pmExpYear } : null,
      paidCount: b.paidCount || 0,
      totalPaidCents: b.totalPaidCents || 0,
      missedCount: b.missedCount || 0,
      missedOpenCents: b.missedOpenCents || 0,
      lastFailureMessage: ['past_due', 'unpaid'].includes(c.status) ? b.lastFailureMessage || '' : '',
    },
    reminders: {
      enabled: !c.reminders || c.reminders.enabled !== false,
      daysBefore: Number(alarm.reminderDaysBefore) || 3,
      // When staff switched reminders off globally, the homeowner's own
      // switch does nothing; the page says so.
      globalEnabled: alarm.paymentRemindersEnabled !== false,
    },
    actions: {
      checkout: canPerform('checkout', c) && Boolean(env.stripe.billable),
      manageCard: Boolean(b.customerId) && Boolean(env.stripe.configured),
    },
    paymentsConfigured: Boolean(env.stripe.billable),
    payments: payments.filter((p) => p.status !== 'draft').map(publicPayment),
    documents: documents
      .filter((d) => isPortalDocumentKind(d.kind))
      .map((d) => ({ kind: d.kind, filename: d.filename, size: d.size, createdAt: d.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

async function loadSetting() {
  try {
    return await Setting.getSingleton();
  } catch {
    return null;
  }
}

// Load a contract the logged-in user is linked to, else throw not_found. The
// query repeats the scope ($in user.contracts) so even a bug in ownsContract
// can't hand out someone else's contract.
async function loadOwnedContract(req, { lean = true } = {}) {
  const id = req.params.id;
  if (!ownsContract(req.portalUser, id)) throw contractError('not_found', 'Not found');
  const q = AlarmContract.findOne({ $and: [{ _id: id }, { _id: { $in: req.portalUser.contracts || [] } }] });
  const c = lean ? await q.lean() : await q;
  if (!c) throw contractError('not_found', 'Not found');
  return c;
}

// First successful login per contract → portal.firstLoginAt + one
// 'portal_login' event (not one per login: that would flood the timeline).
async function recordLogin(user) {
  const now = new Date();
  await PortalUser.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, failedLogins: 0, lockedUntil: null } });
  const ids = user.contracts || [];
  if (!ids.length) return;
  const firsts = await AlarmContract.find({ _id: { $in: ids }, 'portal.firstLoginAt': null }).select('_id lot project number').lean();
  for (const c of firsts) {
    const r = await AlarmContract.updateOne({ _id: c._id, 'portal.firstLoginAt': null }, { $set: { 'portal.firstLoginAt': now } });
    if (r.modifiedCount > 0) {
      await logContractEvent({
        contract: c,
        type: 'portal_login',
        actor: 'homeowner',
        actorName: user.email,
        message: `${user.email} logged in to the homeowner portal for the first time`,
      });
    }
  }
}

async function contractsFor(user) {
  const ids = user.contracts || [];
  if (!ids.length) return [];
  return AlarmContract.find({ _id: { $in: ids } }).sort({ createdAt: -1 }).lean();
}

const invalidCredentials = (res) =>
  res.status(401).json({ error: 'invalid_credentials', message: 'The email or password is incorrect.' });

// ---------------------------------------------------------------------------
// Public auth routes
// ---------------------------------------------------------------------------

router.post('/auth/login', ...loginLimits, async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'validation_failed', message: 'Enter your email and password.' });
  try {
    const user = looksLikeEmail(email) ? await PortalUser.findOne({ email }) : null;
    if (!user || user.disabled || !user.passwordHash) {
      await portalTokens.verifyPassword({ passwordHash: await dummyHash() }, password);
      return invalidCredentials(res);
    }
    // A locked account answers exactly like a wrong password (same body, same
    // bcrypt delay): a distinct 423 would confirm the email has an account.
    // The lock still holds — even the right password is refused until it ends,
    // and "Forgot password" stays open as the way back in.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await portalTokens.verifyPassword({ passwordHash: await dummyHash() }, password);
      return invalidCredentials(res);
    }
    const ok = await portalTokens.verifyPassword(user, password);
    if (!ok) {
      // Atomic $inc so parallel guesses all count; lock on reaching the limit.
      const after = await PortalUser.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { new: true });
      if (after && after.failedLogins >= MAX_FAILED_LOGINS) {
        await PortalUser.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLogins: 0 } });
      }
      return invalidCredentials(res);
    }
    await recordLogin(user);
    startPortalSession(res, user);
    const contracts = await contractsFor(user);
    return res.json({ ok: true, email: user.email, name: user.name, next: nextPathFor(contracts) });
  } catch (err) {
    return sendError(res, err);
  }
});

// The set-password page posts the token from the URL fragment here (never a
// query string, so it stays out of access logs).
router.post('/auth/token-info', ...tokenLimits, async (req, res) => {
  try {
    const r = await portalTokens.peekToken(req.body && req.body.token);
    if (!r.valid) return res.json({ valid: false });
    return res.json({ valid: true, purpose: r.purpose, emailMasked: r.emailMasked });
  } catch (err) {
    return sendError(res, err);
  }
});

// Set-password (invite) and reset share everything but the default purpose;
// either accepts either kind of link, so an old invite still works from the
// reset page and vice versa.
function passwordRoute(purposes) {
  return async (req, res) => {
    try {
      const user = await portalTokens.consumeToken(req.body && req.body.token, purposes, req.body && req.body.password);
      await recordLogin(user);
      startPortalSession(res, user);
      const contracts = await contractsFor(user);
      for (const c of contracts) {
        await logContractEvent({
          contract: c,
          type: 'password_set',
          actor: 'homeowner',
          actorName: user.email,
          message: `${user.email} set a portal password`,
        });
      }
      return res.json({ ok: true, email: user.email, name: user.name, next: nextPathFor(contracts) });
    } catch (err) {
      return sendError(res, err);
    }
  };
}

router.post('/auth/set-password', ...tokenLimits, passwordRoute(['invite', 'reset']));
router.post('/auth/reset', ...tokenLimits, passwordRoute(['reset', 'invite']));

// Always 200 with the same body, and the work happens after the response, so
// neither the answer nor its timing says whether the email has an account.
router.post('/auth/forgot', ...forgotLimits, (req, res) => {
  const email = normEmail(req.body && req.body.email);
  res.json({ ok: true, message: 'If that email has a Genius account, a reset link is on its way.' });
  if (!looksLikeEmail(email)) return;
  setImmediate(() => {
    sendResetEmail(email).catch((err) => console.warn('[portal] reset email failed', err.message));
  });
});

async function sendResetEmail(email) {
  const user = await PortalUser.findOne({ email });
  if (!user || user.disabled) return;
  // There is one token slot per user. Anyone who knows a purchaser's email can
  // post here, so a reset must not quietly swap a live 7-day welcome link for
  // a 1-hour one. Someone who never set a password gets a fresh INVITE link
  // instead (same 7 days, same page as the welcome email). The welcome
  // email's own link is replaced either way, but the newest email always works.
  const pendingInvite = !user.passwordHash
    && user.tokenPurpose === 'invite'
    && user.tokenExpiresAt
    && new Date(user.tokenExpiresAt).getTime() > Date.now();
  const purpose = pendingInvite ? 'invite' : 'reset';
  const raw = await portalTokens.issueToken(user, purpose);
  // Logged against their newest contract (MessageLog / history); a user with
  // none still gets the email.
  const contract = user.contracts && user.contracts.length
    ? await AlarmContract.findOne({ _id: { $in: user.contracts } }).sort({ createdAt: -1 }).lean()
    : null;
  await emails.sendContractEmail({
    contract,
    kind: 'password_reset',
    to: user.email,
    data: { actionUrl: emails.setPasswordUrl(raw, purpose), recipientName: user.name || '', purpose },
    actor: 'homeowner',
    actorName: user.email,
  });
}

router.post('/auth/logout', (req, res) => {
  clearPortalCookie(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------

router.use(requirePortalAuth);

// Portal responses are personal; never let a shared cache keep them.
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

router.get('/me', async (req, res) => {
  try {
    const user = req.portalUser;
    const [setting, contracts] = await Promise.all([loadSetting(), contractsFor(user)]);
    const owner = (setting && setting.owner) || {};
    return res.json({
      email: user.email,
      name: user.name,
      timezone: resolveScheduleTimezone(setting),
      support: { name: owner.name || 'Genius Smart Home', email: owner.email || '', phone: owner.phone || '' },
      contracts: contracts.map(contractSummary),
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/contracts/:id', async (req, res) => {
  try {
    const c = await loadOwnedContract(req);
    const [payments, documents, setting] = await Promise.all([
      ContractPayment.find({ contract: c._id }).sort({ periodStart: -1, invoiceCreatedAt: -1 }).limit(120).lean(),
      ContractDocument.find({ contract: c._id, kind: { $in: Object.keys(PORTAL_DOCUMENT_KINDS) } })
        .select('-data')
        .sort({ createdAt: -1 })
        .lean(),
      loadSetting(),
    ]);
    // Newest of each kind only (an older envelope's copy stays admin-side).
    const seen = new Set();
    const latestDocs = documents.filter((d) => (seen.has(d.kind) ? false : seen.add(d.kind)));
    return res.json(publicContract(c, { payments, documents: latestDocs, setting }));
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/contracts/:id/checkout', async (req, res) => {
  try {
    const c = await loadOwnedContract(req, { lean: false });
    const r = await billing.createCheckoutForContract(c, req.portalUser);
    return res.json({ url: r.url, reused: Boolean(r.reused) });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/contracts/:id/billing-portal', async (req, res) => {
  try {
    const c = await loadOwnedContract(req, { lean: false });
    const r = await billing.createBillingPortalSession(c, { returnUrl: `${env.appUrl}/portal` });
    return res.json({ url: r.url });
  } catch (err) {
    return sendError(res, err);
  }
});

// Display only: the pay page polls this after Stripe redirects back. The
// webhook is what activates the contract; if it is slow, one throttled
// reconcile per contract nudges things along — but only for a session that
// really belongs to this contract (client_reference_id).
const RECONCILE_THROTTLE_MS = 15 * 1000;
const lastReconcile = new Map();

router.get('/contracts/:id/checkout-status', async (req, res) => {
  try {
    let c = await loadOwnedContract(req);
    const sessionId = String(req.query.session_id || '');
    const settled = ['active', 'past_due', 'unpaid', 'canceled'].includes(c.status);
    if (!settled && /^cs_[A-Za-z0-9_]+$/.test(sessionId) && env.stripe.configured) {
      const key = idStr(c);
      const last = lastReconcile.get(key) || 0;
      if (Date.now() - last > RECONCILE_THROTTLE_MS) {
        lastReconcile.set(key, Date.now());
        if (lastReconcile.size > 1000) lastReconcile.delete(lastReconcile.keys().next().value);
        try {
          const s = require('../services/contracts/stripeClient').requireStripe();
          const session = await s.checkout.sessions.retrieve(sessionId);
          if (session && session.client_reference_id === key && session.status === 'complete') {
            await billing.reconcileContract(key, { actor: 'homeowner' });
            c = await AlarmContract.findById(key).lean();
          }
        } catch (err) {
          // Display only: a Stripe hiccup just means "still confirming".
          console.warn('[portal] checkout-status reconcile skipped', err.message);
        }
      }
    }
    const b = c.billing || {};
    return res.json({
      status: c.status,
      billingStatus: b.status || 'none',
      active: c.status === 'active',
      nextChargeAt: b.currentPeriodEnd || null,
      card: b.pmLast4 ? { brand: b.pmBrand || '', last4: b.pmLast4 } : null,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/contracts/:id/documents/:kind', async (req, res) => {
  try {
    const kind = String(req.params.kind || '');
    if (!isPortalDocumentKind(kind)) throw contractError('not_found', 'Not found');
    const c = await loadOwnedContract(req);
    const ref = c.documents && c.documents[PORTAL_DOCUMENT_KINDS[kind].ref];
    const doc = ref
      ? await ContractDocument.findOne({ _id: ref, contract: c._id, kind }).lean()
      : await ContractDocument.findOne({ contract: c._id, kind }).sort({ createdAt: -1 }).lean();
    if (!doc || !doc.data) throw contractError('not_found', 'This document is not available yet');
    const buf = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
    const filename = `${c.number}-${PORTAL_DOCUMENT_KINDS[kind].suffix}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(buf);
  } catch (err) {
    return sendError(res, err);
  }
});

// The homeowner's own switch for the upcoming-payment / card-expiry emails.
// Receipts and failed-payment notices are not affected.
router.patch('/contracts/:id/reminders', async (req, res) => {
  try {
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== 'boolean') throw contractError('validation_failed', 'enabled must be true or false', { field: 'enabled' });
    const c = await loadOwnedContract(req);
    const was = !c.reminders || c.reminders.enabled !== false;
    if (was !== enabled) {
      await AlarmContract.updateOne({ _id: c._id }, { $set: { 'reminders.enabled': enabled } });
      await logContractEvent({
        contract: c,
        type: 'updated',
        actor: 'homeowner',
        actorName: req.portalUser.email,
        message: `Payment reminders turned ${enabled ? 'on' : 'off'} by the homeowner`,
        meta: { field: 'reminders.enabled', value: enabled },
      });
    }
    return res.json({ ok: true, enabled });
  } catch (err) {
    return sendError(res, err);
  }
});

router.helpers = {
  sendError,
  ownsContract,
  isPortalDocumentKind,
  PORTAL_DOCUMENT_KINDS,
  nextPathFor,
  contractSummary,
  publicContract,
  publicPayment,
  looksLikeEmail,
};

module.exports = router;

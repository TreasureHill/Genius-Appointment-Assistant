const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { t, group, done } = require('./contractHarness')(__filename);
const { signPortalToken, PORTAL_COOKIE } = require('../../middleware/portalAuth');
const PortalUser = require('../../models/PortalUser');
const portalRouter = require('../../routes/portal');

// Homeowner portal scoping: the pure helpers behind routes/portal.js, and the
// real router over HTTP for the paths that must answer before any contract
// query (foreign ids → 404, document kinds outside the allow-list → 404, bad
// bodies → 400). No database: PortalUser.findById is stubbed for the session
// check, and every request here is rejected before AlarmContract is touched.

const h = portalRouter.helpers;
const mine = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
const user = { _id: new mongoose.Types.ObjectId(), email: 'jane@example.com', name: 'Jane', tokenVersion: 2, disabled: false, contracts: [mine] };

group('helpers');
t('ownsContract: only ids in user.contracts, malformed ids are "no"', () => {
  assert.strictEqual(h.ownsContract(user, String(mine)), true);
  assert.strictEqual(h.ownsContract(user, String(mine).toUpperCase()), true);
  assert.strictEqual(h.ownsContract(user, String(other)), false);
  assert.strictEqual(h.ownsContract(user, 'not-an-id'), false);
  assert.strictEqual(h.ownsContract(user, '123456789012'), false, '12-char strings are valid ObjectIds to mongoose but not ours');
  assert.strictEqual(h.ownsContract(user, { $ne: null }), false);
  assert.strictEqual(h.ownsContract(null, String(mine)), false);
  assert.strictEqual(h.ownsContract({ contracts: [] }, String(mine)), false);
});
t('documents: only the signed agreement and the certificate', () => {
  assert.strictEqual(h.isPortalDocumentKind('agreement_signed'), true);
  assert.strictEqual(h.isPortalDocumentKind('certificate'), true);
  assert.strictEqual(h.isPortalDocumentKind('agreement_unsigned'), false);
  assert.strictEqual(h.isPortalDocumentKind('other'), false);
  assert.strictEqual(h.isPortalDocumentKind('__proto__'), false);
  assert.strictEqual(h.isPortalDocumentKind('constructor'), false);
});
t('nextPathFor: pay page of the first contract that can check out', () => {
  const awaiting = { _id: mine, status: 'awaiting_payment', needsAttention: '', billing: { status: 'none' } };
  assert.strictEqual(h.nextPathFor([{ _id: other, status: 'active', billing: { status: 'active' } }, awaiting]), `/portal/pay?contract=${mine}`);
  assert.strictEqual(h.nextPathFor([{ ...awaiting, needsAttention: 'package_missing' }]), '/portal');
  assert.strictEqual(h.nextPathFor([]), '/portal');
});
t('publicContract leaks no provider ids, staff notes or co-buyer contacts', () => {
  const c = {
    _id: mine,
    number: 'GA-2026-00042',
    status: 'active',
    package: 'smart',
    pricing: { unitCents: 3299, taxBps: 1300, taxCents: 429, totalCents: 3728, currency: 'cad' },
    property: { projectName: 'Sereno', lotNumber: '0006', address: '12 Main', model: 'A3' },
    purchasers: [{ role: 'buyer', name: 'Jane', email: 'jane@example.com', phone: '416', clientUserId: 'cu1', recipientId: '1' }],
    envelope: { id: 'env-secret-id', status: 'completed' },
    billing: { status: 'active', customerId: 'cus_SECRET', subscriptionId: 'sub_SECRET', checkoutSessionId: 'cs_SECRET', priceId: 'price_SECRET', pmLast4: '4242', pmBrand: 'visa', currentPeriodEnd: new Date('2026-12-03T15:00:00Z') },
    notes: 'staff only remark',
    cancelReason: 'internal',
    createdBy: 'admin',
    reminders: { enabled: false },
  };
  const out = h.publicContract(c, {
    payments: [{ _id: 'p1', status: 'draft' }, { _id: 'p2', status: 'paid', totalCents: 3728, stripeInvoiceId: 'in_SECRET', stripeCustomerId: 'cus_SECRET', receiptEmail: { sentAt: new Date() } }],
    documents: [{ kind: 'agreement_signed', filename: 'a.pdf', size: 10 }, { kind: 'agreement_unsigned', filename: 'u.pdf', size: 10 }],
    setting: { alarm: { reminderDaysBefore: 5, paymentRemindersEnabled: true } },
  });
  const json = JSON.stringify(out);
  for (const secret of ['SECRET', 'env-secret-id', 'staff only remark', 'internal', 'jane@example.com', 'cu1', '"416"']) {
    assert.ok(!json.includes(secret), `leaked ${secret}`);
  }
  assert.strictEqual(out.payments.length, 1, 'drafts hidden');
  assert.deepStrictEqual(out.documents.map((d) => d.kind), ['agreement_signed']);
  assert.deepStrictEqual(out.purchasers, [{ role: 'buyer', name: 'Jane' }]);
  assert.strictEqual(out.billing.card.last4, '4242');
  assert.strictEqual(out.reminders.enabled, false);
  assert.strictEqual(out.reminders.daysBefore, 5);
  assert.strictEqual(out.nextChargeAt.toISOString(), '2026-12-03T15:00:00.000Z');
  assert.strictEqual(out.packageLabel, 'Smart Monitoring');
});

group('router (HTTP, no DB)');
let server;
let base;
const realFindById = PortalUser.findById;
async function start() {
  PortalUser.findById = async (id) => (String(id) === String(user._id) ? { ...user } : null);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/portal', portalRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/portal`;
}
async function stop() {
  PortalUser.findById = realFindById;
  await new Promise((r) => server.close(r));
}
const cookie = () => `${PORTAL_COOKIE}=${signPortalToken(user)}`;
async function call(method, path, { body, auth = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { cookie: cookie() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

t('start test server', start);
t('protected routes need a portal session', async () => {
  const r = await call('GET', '/me', { auth: false });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error, 'unauthenticated');
});
t("another homeowner's contract is a 404 on every :id route", async () => {
  const id = String(other);
  for (const [m, p, body] of [
    ['GET', `/contracts/${id}`],
    ['POST', `/contracts/${id}/checkout`],
    ['POST', `/contracts/${id}/billing-portal`],
    ['GET', `/contracts/${id}/checkout-status?session_id=cs_test_1`],
    ['GET', `/contracts/${id}/documents/agreement_signed`],
    ['PATCH', `/contracts/${id}/reminders`, { enabled: false }],
  ]) {
    const r = await call(m, p, { body });
    assert.strictEqual(r.status, 404, `${m} ${p}`);
    assert.strictEqual(r.json.error, 'not_found');
  }
});
t('malformed ids are 404, not 500', async () => {
  const r = await call('GET', '/contracts/zzz');
  assert.strictEqual(r.status, 404);
});
t('document kinds outside the allow-list are 404 even for my contract', async () => {
  for (const kind of ['agreement_unsigned', 'other', 'constructor']) {
    const r = await call('GET', `/contracts/${mine}/documents/${kind}`);
    assert.strictEqual(r.status, 404, kind);
  }
});
t('PATCH reminders validates the body', async () => {
  const r = await call('PATCH', `/contracts/${mine}/reminders`, { body: { enabled: 'no' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.field, 'enabled');
});
t('protected responses are private, no-store', async () => {
  const r = await call('GET', `/contracts/${other}`);
  assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
});
t('forgot always answers 200 with the same body', async () => {
  const a = await call('POST', '/auth/forgot', { body: { email: 'not-an-email' }, auth: false });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.json.ok, true);
});
t('login without fields is a 400; token-info with no token is invalid', async () => {
  assert.strictEqual((await call('POST', '/auth/login', { body: {}, auth: false })).status, 400);
  const r = await call('POST', '/auth/token-info', { body: {}, auth: false });
  assert.deepStrictEqual(r.json, { valid: false });
});
t('logout clears the psid cookie', async () => {
  const r = await call('POST', '/auth/logout', { auth: false });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /psid=;.*Path=\/api\/portal/);
});
t('form-encoded (cross-site form) POSTs are refused before any auth work', async () => {
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': type }, body: 'email=a%40b.co&password=xxxxxxxxxxxx' });
    assert.strictEqual(res.status, 415, type);
  }
  // no body at all (checkout / logout from our own client) is still fine
  const r = await fetch(`${base}/auth/logout`, { method: 'POST' });
  assert.strictEqual(r.status, 200);
});
t('a locked account answers exactly like a wrong password', async () => {
  const realFindOne = PortalUser.findOne;
  const hash = await require('../contracts/portalTokens').hashPassword('right-password-123');
  PortalUser.findOne = async () => ({ _id: user._id, email: 'locked@example.com', passwordHash: hash, lockedUntil: new Date(Date.now() + 600e3) });
  try {
    const locked = await call('POST', '/auth/login', { body: { email: 'locked@example.com', password: 'right-password-123' }, auth: false });
    PortalUser.findOne = async () => null;
    const unknown = await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-123' }, auth: false });
    assert.strictEqual(locked.status, 401);
    assert.deepStrictEqual(locked.json, unknown.json);
    assert.strictEqual(locked.headers.get('retry-after'), null);
  } finally {
    PortalUser.findOne = realFindOne;
  }
});
t('unknown upstream errors reach the homeowner as a generic message', () => {
  let out;
  const res = { status(s) { out = { s }; return this; }, json(b) { out.b = b; return this; } };
  const realError = console.error;
  console.error = () => {};
  try {
    h.sendError(res, Object.assign(new Error("No such customer: 'cus_SECRET'"), { type: 'StripeInvalidRequestError' }));
  } finally {
    console.error = realError;
  }
  assert.strictEqual(out.s, 502);
  assert.ok(!/cus_SECRET/.test(out.b.message));
  h.sendError(res, require('../contracts/errors').contractError('no_customer', 'Payment has not been set up for this agreement yet'));
  assert.strictEqual(out.b.message, 'Payment has not been set up for this agreement yet');
});
t('stop test server', stop);

module.exports = done();

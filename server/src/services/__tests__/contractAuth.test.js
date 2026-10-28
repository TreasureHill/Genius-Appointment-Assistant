/**
 * Admin vs homeowner session isolation: requireAuth (admin wall) and
 * requirePortalAuth (portal) with mock req/res, the boot-time secret checks,
 * and the guarantee that "closed" never became a lot status. No DB or network.
 */
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { t, group, done } = require('./contractHarness')(__filename);
const env = require('../../config/env');
const { signToken, requireAuth } = require('../../middleware/auth');
const {
  signPortalToken,
  createRequirePortalAuth,
  PORTAL_COOKIE,
  PORTAL_COOKIE_PATH,
} = require('../../middleware/portalAuth');
const Lot = require('../../models/Lot');

function mockRes() {
  const res = { statusCode: 200, body: undefined, cleared: [], cookies: {} };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.clearCookie = (name, opts) => res.cleared.push({ name, opts });
  res.cookie = (name, val, opts) => {
    res.cookies[name] = { val, opts };
  };
  return res;
}

// Run a middleware; resolves { res, nextCalled, req }.
async function run(mw, req) {
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled, req };
}

const admin = { _id: '64b000000000000000000001', username: 'admin', role: 'admin' };
const homeowner = { _id: '64b0000000000000000000aa', email: 'jane@x.com', tokenVersion: 3, disabled: false };
const bearer = (tok) => ({ headers: { authorization: `Bearer ${tok}` }, cookies: {} });
const cookie = (name, tok) => ({ headers: {}, cookies: { [name]: tok } });

group('requireAuth (admin wall)');
t('an admin session passes', async () => {
  const r = await run(requireAuth, cookie('sid', signToken(admin)));
  assert.strictEqual(r.nextCalled, true);
  assert.strictEqual(r.req.user.role, 'admin');
});
t('an admin Bearer token passes', async () => {
  assert.strictEqual((await run(requireAuth, bearer(signToken(admin)))).nextCalled, true);
});
t('no token → 401', async () => {
  const r = await run(requireAuth, { headers: {}, cookies: {} });
  assert.strictEqual(r.res.statusCode, 401);
  assert.strictEqual(r.nextCalled, false);
});
t('a portal token as Bearer → 401 (different secret)', async () => {
  const r = await run(requireAuth, bearer(signPortalToken(homeowner)));
  assert.strictEqual(r.res.statusCode, 401);
  assert.strictEqual(r.nextCalled, false);
});
t('a psid cookie alone → 401 (never read by the admin wall)', async () => {
  const r = await run(requireAuth, cookie(PORTAL_COOKIE, signPortalToken(homeowner)));
  assert.strictEqual(r.res.statusCode, 401);
});
t('admin-secret token with a non-admin role → 403', async () => {
  const tok = jwt.sign({ sub: 'x', role: 'homeowner' }, env.jwtSecret, { expiresIn: '1h' });
  const r = await run(requireAuth, bearer(tok));
  assert.strictEqual(r.res.statusCode, 403);
  assert.strictEqual(r.nextCalled, false);
});
t('admin-secret token with no role → 403', async () => {
  const tok = jwt.sign({ sub: 'x', username: 'old' }, env.jwtSecret, { expiresIn: '1h' });
  assert.strictEqual((await run(requireAuth, bearer(tok))).res.statusCode, 403);
});
t('portal audience is refused even if signed with the admin secret', async () => {
  const tok = jwt.sign({ sub: 'x', role: 'admin' }, env.jwtSecret, { audience: 'portal', expiresIn: '1h' });
  assert.strictEqual((await run(requireAuth, bearer(tok))).res.statusCode, 403);
});
t('a tampered / unsigned token → 401', async () => {
  const none = jwt.sign({ sub: 'x', role: 'admin' }, '', { algorithm: 'none' });
  assert.strictEqual((await run(requireAuth, bearer(none))).res.statusCode, 401);
});

group('requirePortalAuth');
const users = new Map([[homeowner._id, homeowner]]);
const requirePortalAuth = createRequirePortalAuth(async (id) => users.get(String(id)) || null);
t('a valid psid cookie passes and loads the user', async () => {
  const r = await run(requirePortalAuth, cookie(PORTAL_COOKIE, signPortalToken(homeowner)));
  assert.strictEqual(r.nextCalled, true);
  assert.strictEqual(r.req.portalUser, homeowner);
  assert.strictEqual(r.req.portalClaims.aud, 'portal');
  assert.strictEqual(r.req.portalClaims.role, 'homeowner');
});
t('Bearer headers are ignored (cookie only) → 401', async () => {
  const r = await run(requirePortalAuth, bearer(signPortalToken(homeowner)));
  assert.strictEqual(r.res.statusCode, 401);
  assert.strictEqual(r.nextCalled, false);
});
t('an admin token in the psid cookie → 401', async () => {
  const r = await run(requirePortalAuth, cookie(PORTAL_COOKIE, signToken(admin)));
  assert.strictEqual(r.res.statusCode, 401);
  assert.strictEqual(r.res.cleared[0].name, PORTAL_COOKIE);
});
t('a password change (tokenVersion bump) ends old sessions', async () => {
  const old = signPortalToken({ ...homeowner, tokenVersion: 2 });
  const r = await run(requirePortalAuth, cookie(PORTAL_COOKIE, old));
  assert.strictEqual(r.res.statusCode, 401);
  assert.strictEqual(r.res.body.error, 'session_expired');
});
t('disabled or deleted users → 401', async () => {
  users.set('64b0000000000000000000bb', { ...homeowner, _id: '64b0000000000000000000bb', disabled: true });
  const r1 = await run(requirePortalAuth, cookie(PORTAL_COOKIE, signPortalToken({ ...homeowner, _id: '64b0000000000000000000bb' })));
  assert.strictEqual(r1.res.statusCode, 401);
  const r2 = await run(requirePortalAuth, cookie(PORTAL_COOKIE, signPortalToken({ ...homeowner, _id: '64b0000000000000000000cc' })));
  assert.strictEqual(r2.res.statusCode, 401);
});
t('the portal cookie is scoped to /api/portal', () => {
  assert.strictEqual(PORTAL_COOKIE, 'psid');
  assert.strictEqual(PORTAL_COOKIE_PATH, '/api/portal');
});

group('secrets at boot');
t('the portal secret is derived, and never equals the admin secret', () => {
  assert.ok(env.portal.jwtSecret);
  assert.notStrictEqual(env.portal.jwtSecret, env.jwtSecret);
});
t('production refuses the default JWT secret', () => {
  const p = env.secretProblems({ nodeEnv: 'production', jwtSecret: env.DEFAULT_JWT_SECRET, portalSecret: 'x' });
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(env.secretProblems({ nodeEnv: 'development', jwtSecret: env.DEFAULT_JWT_SECRET, portalSecret: 'x' }), []);
});
t('equal admin and portal secrets are refused everywhere', () => {
  assert.strictEqual(env.secretProblems({ nodeEnv: 'development', jwtSecret: 'same', portalSecret: 'same' }).length, 1);
});

group('lot statuses unchanged ("closed" lives in Lot.closing)');
t('Lot.STATUSES and STOP_STATUSES', () => {
  assert.deepStrictEqual(Lot.STATUSES, ['pending', 'contacted', 'scheduled', 'completed', 'opted_out']);
  assert.deepStrictEqual(Lot.STOP_STATUSES, ['scheduled', 'completed', 'opted_out']);
});
t('closing defaults to open', () => {
  const lot = new Lot({ project: '64b000000000000000000001', lotNumber: '0006' });
  assert.strictEqual(lot.closing.closed, false);
  assert.strictEqual(lot.closing.closingDate, null);
  assert.strictEqual(lot.model, '');
  assert.strictEqual(lot.alarmContract, null);
});

module.exports = done();

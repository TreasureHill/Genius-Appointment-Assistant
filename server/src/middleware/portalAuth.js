const jwt = require('jsonwebtoken');
const env = require('../config/env');

// Homeowner portal sessions — isolated from the admin session on purpose:
//   - its own cookie, `psid`, scoped to /api/portal (never sent to the admin API)
//   - cookie only: a Bearer header is ignored, so nothing but the browser
//     session can authenticate
//   - its own secret (env.portal.jwtSecret, never equal to JWT_SECRET)
//   - aud 'portal' + role 'homeowner', which requireAuth refuses outright
//   - `pv` = PortalUser.tokenVersion, bumped on every password set/reset so
//     old sessions die with the old password
const PORTAL_COOKIE = 'psid';
const PORTAL_COOKIE_PATH = '/api/portal';
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

function signPortalToken(user) {
  return jwt.sign(
    { sub: String(user._id), pv: Number(user.tokenVersion) || 0, role: 'homeowner' },
    env.portal.jwtSecret,
    { algorithm: 'HS256', audience: 'portal', issuer: 'genius', expiresIn: SESSION_TTL_SEC }
  );
}

// Throws (jsonwebtoken errors) when the token is bad, expired, or not a
// portal token.
function verifyPortalToken(token) {
  const claims = jwt.verify(token, env.portal.jwtSecret, {
    algorithms: ['HS256'],
    audience: 'portal',
    issuer: 'genius',
  });
  if (claims.role !== 'homeowner') throw new Error('not a homeowner token');
  return claims;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    path: PORTAL_COOKIE_PATH,
  };
}

function setPortalCookie(res, token) {
  res.cookie(PORTAL_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_SEC * 1000 });
}

function clearPortalCookie(res) {
  res.clearCookie(PORTAL_COOKIE, cookieOptions());
}

// Sign + set in one go (login / set-password / reset).
function startPortalSession(res, user) {
  setPortalCookie(res, signPortalToken(user));
}

function readPortalToken(req) {
  return (req.cookies && req.cookies[PORTAL_COOKIE]) || null;
}

// Builds the middleware around a user loader so tests can run it without a
// database. loadUser(id) → PortalUser doc (or null).
function createRequirePortalAuth(loadUser) {
  return async function requirePortalAuth(req, res, next) {
    const token = readPortalToken(req);
    if (!token) return res.status(401).json({ error: 'unauthenticated' });
    let claims;
    try {
      claims = verifyPortalToken(token);
    } catch {
      clearPortalCookie(res);
      return res.status(401).json({ error: 'invalid_token' });
    }
    let user;
    try {
      user = await loadUser(claims.sub);
    } catch {
      user = null;
    }
    if (!user || user.disabled) {
      clearPortalCookie(res);
      return res.status(401).json({ error: 'invalid_token' });
    }
    if ((Number(user.tokenVersion) || 0) !== claims.pv) {
      clearPortalCookie(res);
      return res.status(401).json({ error: 'session_expired' });
    }
    req.portalUser = user;
    req.portalClaims = claims;
    return next();
  };
}

// Lazy require keeps this module loadable (and testable) without mongoose
// models being registered first.
const requirePortalAuth = createRequirePortalAuth((id) => require('../models/PortalUser').findById(id));

module.exports = {
  PORTAL_COOKIE,
  PORTAL_COOKIE_PATH,
  signPortalToken,
  verifyPortalToken,
  setPortalCookie,
  clearPortalCookie,
  startPortalSession,
  readPortalToken,
  createRequirePortalAuth,
  requirePortalAuth,
};

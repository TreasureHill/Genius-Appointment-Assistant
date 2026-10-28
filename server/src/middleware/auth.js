const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), username: user.username, role: user.role },
    env.jwtSecret,
    { expiresIn: '7d' }
  );
}

function setAuthCookie(res, token) {
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie('sid', { path: '/' });
}

function readToken(req) {
  const fromCookie = req.cookies && req.cookies.sid;
  if (fromCookie) return fromCookie;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// Admin API wall. Only the `sid` cookie or a Bearer header is read, so a
// homeowner's `psid` cookie never even reaches jwt.verify (→ 401), and portal
// tokens are signed with a different secret (→ 401 too). The audience/role
// check is defence in depth in case the two secrets were ever configured the
// same: anything that isn't an admin session is refused with 403. Every admin
// token already carries role:'admin' (User.role only allows 'admin'), so this
// logs nobody out.
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (!claims || claims.aud === 'portal' || claims.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  req.user = claims;
  return next();
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, readToken };

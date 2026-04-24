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

function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.user = jwt.verify(token, env.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, readToken };

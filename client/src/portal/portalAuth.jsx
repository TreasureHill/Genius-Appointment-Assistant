import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api';

// Homeowner session, the portal's twin of auth.jsx. It talks only to
// /api/portal/* (psid cookie, scoped to that path) and never to the admin
// /api/auth/me or /api/settings, so a homeowner's browser makes no admin
// calls at all. `me` carries the contracts summary, the support contact and
// the business timezone, which is why the portal needs no TimezoneProvider.

const PortalAuthCtx = createContext(null);

export function PortalAuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/portal/me');
      setMe(data);
      return data;
    } catch {
      // 401 (no cookie, expired, password changed elsewhere) just means
      // "logged out"; api.js never redirects, PortalProtected does.
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Each of these sets the cookie server-side and returns { next }; we load
  // /me straight away so the protected pages render with data, not a flash
  // of the login screen.
  async function login(email, password) {
    const r = await api.post('/api/portal/auth/login', { email, password });
    await refresh();
    return r;
  }

  async function setPassword(mode, token, password) {
    const url = mode === 'reset' ? '/api/portal/auth/reset' : '/api/portal/auth/set-password';
    const r = await api.post(url, { token, password });
    await refresh();
    return r;
  }

  async function logout() {
    try {
      await api.post('/api/portal/auth/logout');
    } catch {
      /* the cookie is cleared or already gone either way */
    }
    setMe(null);
  }

  return (
    <PortalAuthCtx.Provider value={{ me, loading, refresh, login, setPassword, logout }}>
      {children}
    </PortalAuthCtx.Provider>
  );
}

export function usePortalAuth() {
  return useContext(PortalAuthCtx);
}

// ---------------------------------------------------------------------------
// Small display helpers shared by the portal pages
// ---------------------------------------------------------------------------

// api.js errors keep the short code in err.message and the server's body in
// err.data; homeowners should see the sentence, never "invalid_state".
const FRIENDLY = {
  invalid_credentials: 'The email or password is incorrect.',
  account_locked: 'Too many failed attempts. Try again in a few minutes, or reset your password.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  invalid_token: 'This link has expired or was already used.',
  weak_password: 'Choose a longer password (at least 10 characters).',
  not_configured: 'Online payments are not available yet. Genius Smart Home will be in touch.',
  stripe_catalog_mismatch: 'Online payments are temporarily unavailable. Please try again later.',
  already_subscribed: 'Your monthly payment is already set up.',
  package_missing: 'We are confirming your monitoring package. Genius Smart Home will be in touch.',
  no_customer: 'There is no card on file yet.',
  not_found: 'We could not find that agreement on your account.',
  unauthenticated: 'Your session has ended. Please log in again.',
  session_expired: 'Your session has ended. Please log in again.',
  'Failed to fetch': 'Could not reach the server. Check your connection and try again.',
};

export function errText(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return fallback;
  const code = err.message || '';
  if (FRIENDLY[code]) return FRIENDLY[code];
  if (err.data && err.data.message) return err.data.message;
  return fallback;
}

function safeTz(tz) {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

// "November 3, 2026" in the business timezone (falls back to the browser's).
export function fmtDate(d, tz) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: safeTz(tz) }).format(date);
}

// "Nov 3, 2026" for dense table rows.
export function fmtShortDate(d, tz) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: safeTz(tz) }).format(date);
}

// Day of the month for `d` in `tz`, as "3rd" / "21st" / "30th".
export function dayOrdinal(d, tz) {
  const date = d instanceof Date ? d : new Date(d || Date.now());
  const n = Number(new Intl.DateTimeFormat('en-CA', { day: 'numeric', timeZone: safeTz(tz) }).format(date));
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

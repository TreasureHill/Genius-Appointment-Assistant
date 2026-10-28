import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api';

// The server answers the same way whether or not the email has an account,
// and so does this page: after submit it always shows the same message, even
// on a network error, so the page can't be used to probe for accounts.
export default function PortalForgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Reset password · Genius Smart Home';
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/portal/auth/forgot', { email: email.trim() });
    } catch {
      /* same answer either way (see above) */
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card portal-auth-card" onSubmit={submit}>
        <div className="portal-auth-brand">
          <span className="portal-mark" aria-hidden="true">G</span>
          Genius Smart Home
        </div>
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <div className="success" role="status">
              If that email has a Genius account, a reset link is on its way.
            </div>
            <p className="muted portal-auth-foot">
              The link works for one hour. Check your spam folder if it hasn't arrived in a few minutes.
            </p>
          </>
        ) : (
          <>
            <div className="sub">Enter the email address on your monitoring agreement and we'll email you a reset link.</div>
            <label htmlFor="portal-forgot-email">Email</label>
            <input
              id="portal-forgot-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" disabled={busy} className="portal-wide">
              {busy ? 'Sending…' : 'Email me a reset link'}
            </button>
          </>
        )}
        <div className="portal-auth-links">
          <Link to="/portal/login">Back to log in</Link>
        </div>
      </form>
    </div>
  );
}

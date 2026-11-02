import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { usePortalAuth, errText } from './portalAuth.jsx';

export default function PortalLogin() {
  const { me, loading, login } = usePortalAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const location = useLocation();
  // Where PortalProtected bounced them from (an emailed pay link, say). Only
  // portal paths: anything else falls back to the server's suggestion.
  const fromPath = location.state?.from ? location.state.from.pathname + (location.state.from.search || '') : '';
  const from = fromPath.startsWith('/portal') && fromPath !== '/portal/login' ? fromPath : '';

  useEffect(() => {
    document.title = 'Log in · Genius Smart Home';
  }, []);

  if (!loading && me && !busy) return <Navigate to={from || '/portal'} replace />;

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await login(email.trim(), password);
      nav(from || (r && r.next) || '/portal', { replace: true });
    } catch (ex) {
      setErr(errText(ex));
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card portal-auth-card" onSubmit={submit}>
        <div className="portal-auth-brand">
          <span className="portal-mark" aria-hidden="true">G</span>
          Genius Smart Home
        </div>
        <h1>Log in</h1>
        <div className="sub">Your alarm monitoring account: payments, receipts and your signed agreement.</div>
        <label htmlFor="portal-email">Email</label>
        <input
          id="portal-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        <label htmlFor="portal-password">Password</label>
        <input
          id="portal-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {err && (
          <div className="error" role="alert">
            {err}
          </div>
        )}
        <button type="submit" disabled={busy} className="portal-wide">
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <div className="portal-auth-links">
          <Link to="/portal/forgot">Forgot your password?</Link>
        </div>
        <p className="portal-auth-foot muted">
          First time here? Use the "Create your password" link in the email we sent when your agreement was signed.
        </p>
      </form>
    </div>
  );
}

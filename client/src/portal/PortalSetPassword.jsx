import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { usePortalAuth, errText } from './portalAuth.jsx';

const MIN_PASSWORD_LENGTH = 10; // server: portalTokens.MIN_PASSWORD_LENGTH

// The one-time token arrives in the URL fragment (#t=…), which browsers never
// send to a server, so it stays out of access logs and Referer headers.
function readHashToken() {
  try {
    const m = /(?:^#|&)t=([^&]+)/.exec(window.location.hash || '');
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

// mode "set" (welcome invite) or "reset" (forgot password). The server lets
// either page accept either kind of link, so an old invite still works here.
export default function PortalSetPassword({ mode = 'set' }) {
  const { setPassword } = usePortalAuth();
  const nav = useNavigate();
  // Read once, before the effect below strips it from the address bar.
  const [token] = useState(readHashToken);
  // checking | ready | expired
  const [phase, setPhase] = useState(token ? 'checking' : 'expired');
  const [emailMasked, setEmailMasked] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const isReset = mode === 'reset';

  useEffect(() => {
    document.title = `${isReset ? 'Reset password' : 'Create your password'} · Genius Smart Home`;
  }, [isReset]);

  // Take the token out of the URL (history, bookmarks, screen shares) as soon
  // as we hold it in memory.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    api
      .post('/api/portal/auth/token-info', { token })
      .then((r) => {
        if (cancelled) return;
        if (r && r.valid) {
          setEmailMasked(r.emailMasked || '');
          setPhase('ready');
        } else {
          setPhase('expired');
        }
      })
      .catch((ex) => {
        if (cancelled) return;
        // A rate limit or outage isn't an expired link; let them try the form.
        if (ex.status === 429 || !ex.status || ex.status >= 500) {
          setErr(errText(ex));
          setPhase('ready');
        } else {
          setPhase('expired');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (pw.length < MIN_PASSWORD_LENGTH) return setErr(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (pw !== pw2) return setErr('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await setPassword(mode, token, pw);
      nav((r && r.next) || '/portal', { replace: true });
    } catch (ex) {
      setBusy(false);
      if (ex.message === 'invalid_token') setPhase('expired');
      else setErr(errText(ex));
    }
  }

  const title = isReset ? 'Choose a new password' : 'Create your password';

  return (
    <div className="login-page">
      <form className="login-card portal-auth-card" onSubmit={submit}>
        <div className="portal-auth-brand">
          <span className="portal-mark" aria-hidden="true">G</span>
          Genius Smart Home
        </div>
        <h1>{phase === 'expired' ? 'This link has expired' : title}</h1>

        {phase === 'checking' && <div className="sub">Checking your link…</div>}

        {phase === 'expired' && (
          <>
            <div className="sub">
              Links in our emails work once and only for a limited time. Request a new one and we'll email it to you.
            </div>
            <Link to="/portal/forgot" className="btn-link portal-wide-link">
              Request a new link
            </Link>
            <div className="portal-auth-links">
              <Link to="/portal/login">Already have a password? Log in</Link>
            </div>
          </>
        )}

        {phase === 'ready' && (
          <>
            <div className="sub">
              {emailMasked ? (
                <>
                  Setting the password for <strong>{emailMasked}</strong>.
                </>
              ) : (
                'Choose a password for your Genius Smart Home account.'
              )}
            </div>
            <label htmlFor="portal-new-password">New password</label>
            <input
              id="portal-new-password"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              required
            />
            <div className="portal-hint muted">At least {MIN_PASSWORD_LENGTH} characters.</div>
            <label htmlFor="portal-new-password2">Confirm password</label>
            <input
              id="portal-new-password2"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              required
            />
            {err && (
              <div className="error" role="alert">
                {err}
              </div>
            )}
            <button type="submit" disabled={busy} className="portal-wide">
              {busy ? 'Saving…' : isReset ? 'Save new password' : 'Create password and continue'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}

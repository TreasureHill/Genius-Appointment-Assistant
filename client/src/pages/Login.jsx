import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const [username, setU] = useState('admin');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    if (user) nav('/', { replace: true });
  }, [user, nav]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(username, password);
      nav('/', { replace: true });
    } catch (ex) {
      setErr(ex.message || 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>Genius Appointment Assistant</h1>
        <div className="sub">Sign in with your admin credentials.</div>
        <label>Username</label>
        <input value={username} onChange={(e) => setU(e.target.value)} autoFocus />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setP(e.target.value)} />
        {err && <div className="error">{err}</div>}
        <button type="submit" disabled={busy} style={{ width: '100%', marginTop: 16 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

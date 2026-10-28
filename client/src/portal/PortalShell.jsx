import { Link, useNavigate } from 'react-router-dom';
import { usePortalAuth } from './portalAuth.jsx';

// Chrome for the logged-in portal pages: a slim brand bar (no admin sidebar,
// no admin links) and a centred, phone-friendly content column.
export default function PortalShell({ children }) {
  const { me, logout } = usePortalAuth();
  const nav = useNavigate();

  async function onLogout() {
    await logout();
    nav('/portal/login', { replace: true });
  }

  return (
    <div className="portal-root">
      <header className="portal-top">
        <Link to="/portal" className="portal-brand" aria-label="Genius Smart Home, my account">
          <span className="portal-mark" aria-hidden="true">G</span>
          <span className="portal-brand-name">Genius Smart Home</span>
        </Link>
        <div className="portal-top-right">
          {me && <span className="portal-user muted">{me.name || me.email}</span>}
          <button className="secondary small" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      <main className="main portal-main">{children}</main>
    </div>
  );
}

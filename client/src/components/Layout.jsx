import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

const links = [
  { to: '/', label: 'Dashboard', icon: '◧', end: true },
  { to: '/board', label: 'Board', icon: '▦' },
  { to: '/projects', label: 'Projects', icon: '▤' },
  { to: '/templates', label: 'Templates', icon: '✎' },
  { to: '/import', label: 'Import / Export', icon: '⇅' },
  { to: '/history', label: 'History', icon: '⏱' },
  { to: '/calendly', label: 'Calendly events', icon: '📅' },
  { to: '/reports', label: 'Reports', icon: '📊' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  async function onLogout() {
    await logout();
    nav('/login', { replace: true });
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <span>Genius Appointments</span>
        </div>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}>
              <span className="nav-icon" aria-hidden="true">
                {l.icon}
              </span>
              <span>{l.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip" title={user?.username}>
            <span className="avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{user?.username}</span>
          </div>
          <button className="logout" onClick={onLogout}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main">
        {/* Key by path so a crash on one page becomes an inline, recoverable
            error (sidebar stays usable) and navigating elsewhere resets it. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

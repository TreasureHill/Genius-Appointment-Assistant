import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';

// Simple, professional line icons (stroke = currentColor) — no emojis.
function Icon({ name }) {
  const paths = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
      </>
    ),
    board: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18M15 3v18" />
      </>
    ),
    projects: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    templates: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    importExport: (
      <>
        <path d="M17 3l4 4-4 4M21 7H9" />
        <path d="M7 21l-4-4 4-4M3 17h12" />
      </>
    ),
    activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
    history: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18M8 2v4M16 2v4" />
      </>
    ),
    reports: (
      <>
        <path d="M3 21h18" />
        <rect x="5" y="11" width="3" height="7" rx="0.5" />
        <rect x="10.5" y="7" width="3" height="11" rx="0.5" />
        <rect x="16" y="13" width="3" height="5" rx="0.5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
    collapse: <path d="M15 6l-6 6 6 6" />,
    expand: <path d="M9 6l6 6-6 6" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || null}
    </svg>
  );
}

const links = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/projects', label: 'Projects', icon: 'projects' },
  { to: '/templates', label: 'Templates', icon: 'templates' },
  { to: '/import', label: 'Import / Export', icon: 'importExport' },
  { to: '/activity', label: 'Activity log', icon: 'activity' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/calendly', label: 'Calendly events', icon: 'calendar' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar:collapsed') === '1');

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem('sidebar:collapsed', next ? '1' : '0');
      return next;
    });
  }

  async function onLogout() {
    await logout();
    nav('/login', { replace: true });
  }

  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="brand">
          <span className="brand-mark">G</span>
          {!collapsed && <span className="brand-name">Genius Appointments</span>}
          <button
            className="sidebar-toggle"
            onClick={toggle}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          >
            <Icon name={collapsed ? 'expand' : 'collapse'} />
          </button>
        </div>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} title={collapsed ? l.label : undefined}>
              <span className="nav-icon">
                <Icon name={l.icon} />
              </span>
              {!collapsed && <span className="nav-label">{l.label}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip" title={user?.username}>
            <span className="avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</span>
            {!collapsed && <span className="user-name">{user?.username}</span>}
          </div>
          <button className="logout" onClick={onLogout} title="Log out">
            {collapsed ? '⎋' : 'Log out'}
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

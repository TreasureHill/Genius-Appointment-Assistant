import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/reps', label: 'Reps' },
  { to: '/templates', label: 'Templates' },
  { to: '/import', label: 'Import / Export' },
  { to: '/history', label: 'History' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  async function onLogout() {
    await logout();
    nav('/login', { replace: true });
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Genius Appointments</div>
        <nav>
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="logout" onClick={onLogout} title={user?.username}>
          Log out ({user?.username})
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

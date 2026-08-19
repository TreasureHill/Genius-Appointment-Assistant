import { Link, useLocation } from 'react-router-dom';

export default function NotFound() {
  const location = useLocation();
  return (
    <div>
      <h1>Page not found</h1>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          There's nothing at <span className="kbd">{location.pathname}</span>. The link may be
          stale, or the item it pointed to was deleted.
        </p>
        <p style={{ marginBottom: 0 }}>
          <Link to="/">← Back to the dashboard</Link>
        </p>
      </div>
    </div>
  );
}

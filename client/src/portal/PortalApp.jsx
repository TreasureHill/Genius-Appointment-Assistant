import { Component } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { PortalAuthProvider, usePortalAuth } from './portalAuth.jsx';
import PortalShell from './PortalShell.jsx';
import PortalLogin from './PortalLogin.jsx';
import PortalForgot from './PortalForgot.jsx';
import PortalSetPassword from './PortalSetPassword.jsx';
import PortalHome from './PortalHome.jsx';
import PortalPay from './PortalPay.jsx';
import './portal.css';

// Homeowner portal (/portal/*). Mounted in App.jsx OUTSIDE the admin
// Protected layout, with its own session (PortalAuthProvider against
// /api/portal/me). Deliberately no TimezoneProvider: that loads the
// admin-only /api/settings; the portal gets its timezone from /me.

// The app-wide ErrorBoundary's recovery button goes to the admin dashboard,
// which a homeowner can't open. This one keeps them inside the portal.
class PortalErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[portal] uncaught render error:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Something went wrong</h1>
          <div className="sub">This page hit an unexpected error. Your account and payments are not affected.</div>
          <button style={{ width: '100%' }} onClick={() => window.location.assign('/portal')}>
            Back to my account
          </button>
        </div>
      </div>
    );
  }
}

// Logged-out visitors go to the login page, remembering where they were
// headed (an emailed /portal/pay?contract=… link, for instance).
function PortalProtected() {
  const { me, loading } = usePortalAuth();
  const location = useLocation();
  if (loading) return <div className="center">Loading…</div>;
  if (!me) return <Navigate to="/portal/login" replace state={{ from: location }} />;
  return (
    <PortalShell>
      <Outlet />
    </PortalShell>
  );
}

export default function PortalApp() {
  const location = useLocation();
  return (
    // The provider sits outside the boundary so a page crash doesn't throw
    // away the session; keying the boundary by path lets the next navigation
    // recover without a reload.
    <PortalAuthProvider>
      <PortalErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="login" element={<PortalLogin />} />
          <Route path="forgot" element={<PortalForgot />} />
          <Route path="set-password" element={<PortalSetPassword mode="set" />} />
          <Route path="reset" element={<PortalSetPassword mode="reset" />} />
          <Route element={<PortalProtected />}>
            <Route index element={<PortalHome />} />
            <Route path="pay" element={<PortalPay />} />
            <Route path="*" element={<Navigate to="/portal" replace />} />
          </Route>
        </Routes>
      </PortalErrorBoundary>
    </PortalAuthProvider>
  );
}

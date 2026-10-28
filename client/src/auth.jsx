import { createContext, useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from './api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Homeowner portal pages have their own session (psid cookie); asking the
  // admin /api/auth/me there would only 401. Check again if the app later
  // navigates out of /portal.
  const onPortal = useLocation().pathname.startsWith('/portal');

  async function refresh() {
    try {
      const me = await api.get('/api/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (onPortal) {
      setLoading(false);
      return;
    }
    refresh();
  }, [onPortal]);

  async function login(username, password) {
    const me = await api.post('/api/auth/login', { username, password });
    setUser(me);
    return me;
  }

  async function logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {}
    setUser(null);
  }

  return <AuthCtx.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}

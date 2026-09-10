import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

// The sending-schedule timezone (Settings → Sending schedule), shared with
// every page so scheduled and logged times are all shown in the same zone.
// `timezone` is null until settings load; the time helpers then fall back to
// the browser's zone, so nothing waits on it.
const TimezoneContext = createContext({ timezone: null, refresh: () => {}, setTimezone: () => {} });

export function TimezoneProvider({ children }) {
  const [timezone, setTimezone] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/settings');
      setTimezone(s?.schedule?.timezone || null);
    } catch {
      /* keep the browser zone */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const value = useMemo(() => ({ timezone, refresh, setTimezone }), [timezone, refresh]);
  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

export function useTimezone() {
  return useContext(TimezoneContext);
}

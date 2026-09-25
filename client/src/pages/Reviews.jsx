import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { fmtDateTime, relativeTime, tzAbbrev } from '../time';
import TrendChart from '../components/reviews/TrendChart.jsx';
import ReviewLog from '../components/reviews/ReviewLog.jsx';
import RepsManageCard from '../components/reviews/RepsManageCard.jsx';
import SetupCard from '../components/reviews/SetupCard.jsx';
import { Stars, RepBadge, downloadFile, plural } from '../components/reviews/bits.jsx';

// The Reviews tab: every Google review on the listing, week by week, credited
// to the reps it mentions — the numbers the weekly Genius deck reports, live,
// plus the non-Genius reviews and a way to fix the matcher's misses by hand.

function Tile({ label, value, hint, accent, onClick, title }) {
  return (
    <div
      className={`tile${accent ? ` tile-${accent}` : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
      style={onClick ? { cursor: 'pointer' } : undefined}
      title={title}
    >
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
      {hint && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function RepRows({ reps }) {
  if (!reps.length) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        No active reps. Add them under <strong>Reps &amp; matching</strong> below.
      </div>
    );
  }
  const max = Math.max(1, ...reps.map((r) => r.allTime));
  return (
    <div>
      {reps.map((r) => (
        <div key={r._id} className="rv-rep-row">
          <div>
            <RepBadge rep={r} />
            {r.role && (
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                {r.role}
              </div>
            )}
          </div>
          <div>
            <div className="big">{r.week}</div>
            <div className="sub">
              this week{r.weekFiveStar ? ` · ${r.weekFiveStar} five-star` : ''}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12 }}>
              <strong>{r.allTime.toLocaleString()}</strong> <span className="muted">all time</span>
            </div>
            <div className="rv-bar" aria-hidden="true">
              <span style={{ width: `${(100 * r.allTime) / max}%`, background: r.color || 'var(--primary)' }} />
            </div>
            <div className="sub">{r.allTime ? `${Math.round((r.allTimeFiveStar / r.allTime) * 100)}% five-star` : ''}</div>
          </div>
          <div className="rv-rep-avg">
            <Stars rating={r.avgRating} title={`${r.avgRating} average`} />
            <div className="sub">{r.allTime ? `${Number(r.avgRating).toFixed(2)} avg` : 'no reviews yet'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Reviews() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { timezone: ctxTz } = useTimezone();
  const [config, setConfig] = useState(null);
  const [stats, setStats] = useState(null);
  const [reps, setReps] = useState([]);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [downloading, setDownloading] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [repsOpen, setRepsOpen] = useState(false);
  const [custom, setCustom] = useState({ start: '', end: '' });

  const start = searchParams.get('start') || '';
  const end = searchParams.get('end') || '';
  const filters = useMemo(
    () => ({
      show: searchParams.get('show') || 'all',
      rep: searchParams.get('rep') || '',
      scope: searchParams.get('scope') || 'window',
      q: searchParams.get('q') || '',
    }),
    [searchParams]
  );

  const setParams = useCallback(
    (patch) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === 'all' || (k === 'scope' && v === 'window')) next.delete(k);
        else next.set(k, String(v));
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const windowQs = start && end ? `?start=${start}&end=${end}` : start ? `?start=${start}` : end ? `?end=${end}` : '';

  const loadConfig = useCallback(async () => {
    const c = await api.get('/api/reviews/config');
    setConfig(c);
    return c;
  }, []);
  const loadStats = useCallback(async () => {
    const s = await api.get(`/api/reviews/stats${windowQs}`);
    setStats(s);
    return s;
  }, [windowQs]);
  const loadReps = useCallback(async () => {
    const r = await api.get('/api/reviews/reps');
    setReps(Array.isArray(r) ? r : []);
  }, []);

  useEffect(() => {
    setErr('');
    Promise.all([loadConfig(), loadReps()])
      .then(([c]) => {
        if (c && !c.serpapiKeySet && c.counts.reviews === 0) setSetupOpen(true);
      })
      .catch((e) => setErr(e.message));
  }, [loadConfig, loadReps]);

  useEffect(() => {
    loadStats().catch((e) => setErr(e.message));
  }, [loadStats]);

  useEffect(() => {
    if (stats?.window) setCustom({ start: stats.window.start, end: stats.window.end });
  }, [stats?.window?.start, stats?.window?.end]);

  const refreshAll = useCallback(() => {
    loadConfig().catch(() => {});
    loadStats().catch(() => {});
    loadReps().catch(() => {});
    setRefreshKey((k) => k + 1);
  }, [loadConfig, loadStats, loadReps]);

  async function sync(full = false) {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.post('/api/reviews/sync', { full });
      setSyncMsg(
        `${r.full ? 'Full read' : 'Synced'}: ${r.added} new, ${r.updated} updated · ${plural(r.searches, 'search', 'searches')} · ${plural(r.stored, 'review')} stored.` +
          (r.warning ? ` ${r.warning}` : '')
      );
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`);
      if (e.status === 400) setSetupOpen(true);
    } finally {
      setSyncing(false);
      refreshAll();
    }
  }

  async function download(kind) {
    setDownloading(kind);
    try {
      await downloadFile(`/api/reviews/${kind === 'deck' ? 'deck.pptx' : 'export.xlsx'}${windowQs}`, kind === 'deck' ? 'genius-google-reviews.pptx' : 'genius-google-reviews.xlsx');
    } catch (e) {
      setSyncMsg(`Error: ${e.message}`);
    } finally {
      setDownloading('');
    }
  }

  const tz = stats?.timezone || ctxTz;
  const win = stats?.window;

  if (err && !stats) return <div className="error">{err}</div>;
  if (!stats || !config) return <div className="muted">Loading…</div>;

  const w = stats.week;
  const listing = stats.listing || config.listing;
  // null until a sync has actually run (the API hides the schema defaults)
  const ls = stats.lastSync && stats.lastSync.at ? stats.lastSync : null;
  const stale = stats.lastSyncAt && Date.now() - new Date(stats.lastSyncAt).getTime() > 2 * 24 * 3600 * 1000;
  const noData = stats.stored === 0;

  function goToLog(show) {
    setParams({ show, scope: 'window' });
    document.getElementById('review-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const period = win.isCurrentWeek ? 'this week' : 'in window';

  let strip = null;
  if (!config.serpapiKeySet && noData) {
    strip = (
      <div className="card alert alert-warn" style={{ padding: '12px 16px' }}>
        <strong>Not connected yet.</strong> Paste your SerpApi key under <a href="#reviews-setup" onClick={() => setSetupOpen(true)}>Setup</a> to pull
        the listing's reviews, or import a JSON export there. Reps and their nicknames are ready under Reps &amp; matching.
      </div>
    );
  } else if (ls && ls.ok === false) {
    strip = (
      <div className="card alert alert-err" style={{ padding: '12px 16px' }}>
        <strong>Last sync failed</strong> {ls.at ? relativeTime(ls.at) : ''}: {ls.message}.{' '}
        {stats.lastSyncAt ? `Showing reviews as of ${fmtDateTime(stats.lastSyncAt, tz)}.` : 'No reviews have been pulled yet.'}{' '}
        <a href="#reviews-setup" onClick={() => setSetupOpen(true)}>
          Check the setup
        </a>
        .
      </div>
    );
  } else {
    const partial = ls && ls.warning;
    strip = (
      <div className={`card alert ${partial || stale ? 'alert-warn' : ''}`} style={{ padding: '10px 16px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>
          {partial ? (
            <>
              <strong>Incomplete:</strong> {ls.warning}{' '}
            </>
          ) : null}
          {stats.lastSyncAt ? (
            <>
              Reviews as of <strong>{fmtDateTime(stats.lastSyncAt, tz)}</strong> ({relativeTime(stats.lastSyncAt)})
              {ls && ls.message ? <span className="muted"> · last run: {ls.message}</span> : null}
            </>
          ) : (
            <>No sync has run yet{noData ? '' : ' — showing imported reviews'}.</>
          )}
          <span className="muted">
            {' '}
            · {stats.autoSyncHours > 0 ? `refreshes every ${stats.autoSyncHours} h` : 'auto-refresh off'}
            {stale ? ' · looks stale' : ''}
          </span>
        </span>
        {syncMsg && <span className={syncMsg.startsWith('Error') ? 'error' : 'success'} style={{ margin: 0 }}>{syncMsg}</span>}
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Google reviews</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {listing && listing.total ? (
              <>
                <strong>{listing.title || 'The listing'}</strong>
                {listing.address ? ` · ${listing.address}` : ''} · {Number(listing.total).toLocaleString()} reviews on Google
                {listing.rating ? `, ${Number(listing.rating).toFixed(1)}★ overall` : ''}.{' '}
              </>
            ) : null}
            Every review on the listing, tagged with the reps it mentions. Genius-related = names a rep or uses a Genius term.
            Dates in {tz || 'your local zone'}
            {tz ? ` (${tzAbbrev(tz)})` : ''}.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary" onClick={() => sync(false)} disabled={syncing || !config.serpapiKeySet} title={config.serpapiKeySet ? 'Pull new and edited reviews now (1–3 SerpApi searches)' : 'Add a SerpApi key under Setup first'}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button type="button" className="secondary" onClick={() => download('xlsx')} disabled={downloading !== ''} title="Summary, reps, this window's log and every review — as an Excel workbook">
            {downloading === 'xlsx' ? 'Exporting…' : 'Export Excel'}
          </button>
          <button type="button" onClick={() => download('deck')} disabled={downloading !== ''} title="The weekly PowerPoint deck for the window shown">
            {downloading === 'deck' ? 'Building…' : 'Download deck (.pptx)'}
          </button>
        </div>
      </div>

      {strip}
      {syncMsg && (!config.serpapiKeySet || (ls && ls.ok === false)) && (
        <div className={syncMsg.startsWith('Error') ? 'error' : 'success'}>{syncMsg}</div>
      )}

      <div className="rv-weeknav card" style={{ padding: '10px 14px' }}>
        <button type="button" className="secondary small" onClick={() => setParams(win.prev)} title={`${win.prev.start} → ${win.prev.end}`}>
          ‹ Previous week
        </button>
        <span className="rv-range">
          {win.label}
          {win.isCurrentWeek ? <span className="muted" style={{ fontWeight: 400 }}> · this week so far</span> : null}
        </span>
        {!win.isCurrentWeek && (
          <button type="button" className="secondary small" onClick={() => setParams({ start: '', end: '' })}>
            This week
          </button>
        )}
        {win.next && (
          <button type="button" className="secondary small" onClick={() => setParams(win.next)} title={`${win.next.start} → ${win.next.end}`}>
            Next week ›
          </button>
        )}
        <span style={{ flex: 1 }} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (custom.start && custom.end) setParams({ start: custom.start, end: custom.end });
          }}
          style={{ display: 'flex', gap: 6, alignItems: 'center' }}
          title="Any range — the deck and the Excel export follow it too"
        >
          <input type="date" value={custom.start} max={win.today} onChange={(e) => setCustom({ ...custom, start: e.target.value })} />
          <span className="muted">to</span>
          <input type="date" value={custom.end} max={win.today} onChange={(e) => setCustom({ ...custom, end: e.target.value })} />
          <button type="submit" className="secondary small" disabled={!custom.start || !custom.end}>
            Apply
          </button>
        </form>
      </div>

      <div className="tiles">
        <Tile label={`Genius reviews ${period}`} value={w.genius} hint={w.total ? `of ${plural(w.total, 'review')} on the listing` : `none ${period}${win.isCurrentWeek ? ' yet' : ''}`} onClick={() => goToLog('genius')} title={`Show the Genius-related reviews ${period}`} />
        <Tile label={`5★ Genius ${period}`} value={w.geniusFiveStar} hint={w.genius ? `${Number(w.geniusAvgRating).toFixed(2)} average` : undefined} accent={w.genius && w.geniusFiveStar === w.genius ? 'ok' : ''} onClick={() => goToLog('five')} title={`Show the five-star reviews ${period}`} />
        <Tile label={`Other reviews ${period}`} value={w.other} hint="not Genius-related" onClick={() => goToLog('other')} title={`Show the non-Genius reviews ${period}`} />
        <Tile label="Needs mapping" value={w.unmapped} hint={w.unmapped ? 'Genius-related, credited to nobody' : 'every Genius review has a rep'} accent={w.unmapped ? 'err' : ''} onClick={() => goToLog('unmapped')} title="Genius-related reviews the matcher could not credit — map them by hand" />
        <Tile label="Rated 3★ or less" value={w.lowRated} hint={w.lowRated ? `${w.lowUnreplied} without an owner reply` : `none ${period}`} accent={w.lowRated ? 'err' : ''} onClick={() => goToLog('low')} title={`Show the low-rated reviews ${period}`} />
        <Tile label="Genius reviews all time" value={stats.allTime.genius.toLocaleString()} hint={`${stats.allTime.geniusFiveStar.toLocaleString()} five-star · ${stats.allTime.total.toLocaleString()} reviews stored`} />
        {listing && listing.total ? <Tile label="On Google" value={Number(listing.total).toLocaleString()} hint={listing.rating ? `${Number(listing.rating).toFixed(1)}★ listing average` : undefined} /> : null}
      </div>

      <div className="rv-grid">
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: '0 0 2px' }}>Reviews per week</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            The 12 weeks up to the one shown, Monday to Sunday. Click a week to open it.
          </div>
          <TrendChart trend={stats.trend} selected={{ start: win.start }} onPickWeek={(b) => setParams({ start: b.start, end: b.current ? '' : b.end })} />
        </div>
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: '0 0 2px' }}>Reps</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Mentions in the window shown, and all time. One review can credit several reps.
          </div>
          <RepRows reps={stats.reps} />
        </div>
      </div>

      <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        Review log
        <span className="muted" style={{ fontWeight: 400, fontSize: 12, textTransform: 'none', letterSpacing: 0 }}>
          Genius and non-Genius alike · map any review to a rep with <em>Map to a rep</em>
        </span>
      </h2>
      <ReviewLog window={win} reps={reps} tz={tz} filters={filters} onFilters={setParams} refreshKey={refreshKey} onChanged={() => loadStats().catch(() => {})} />

      <h2 style={{ marginTop: 30 }}>Configuration</h2>
      <details className="rv-details" open={repsOpen} onToggle={(e) => setRepsOpen(e.target.open)}>
        <summary>
          <span className="muted">{repsOpen ? '▾' : '▸'}</span> Reps &amp; matching
          <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
            {plural(reps.filter((r) => r.active !== false).length, 'active rep')} · Genius terms: {(config.geniusTerms || []).join(', ') || 'none'}
            {config.counts.unmapped ? ` · ${plural(config.counts.unmapped, 'review')} still need mapping` : ''}
          </span>
        </summary>
        {repsOpen && <RepsManageCard reps={reps} geniusTerms={config.geniusTerms} onChanged={refreshAll} />}
      </details>
      <details id="reviews-setup" className="rv-details" open={setupOpen} onToggle={(e) => setSetupOpen(e.target.open)}>
        <summary>
          <span className="muted">{setupOpen ? '▾' : '▸'}</span> Setup
          <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
            SerpApi key {config.serpapiKeySet ? `set (${config.serpapiKeyHint})` : 'missing'} · auto-sync {config.autoSyncHours > 0 ? `every ${config.autoSyncHours} h` : 'off'} · import / full resync
          </span>
        </summary>
        {setupOpen && <SetupCard config={config} tz={tz} onSaved={refreshAll} onSync={sync} syncing={syncing} />}
      </details>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Week boundaries and dates use the sending-schedule timezone from <Link to="/settings">Settings</Link>.
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../api';
import { fmtDateTime } from '../../time';
import { plural } from './bits.jsx';

// Setup: the SerpApi key, the listing, the sync cadence, deck branding, and a
// JSON import for manual exports / the demo fixture.

export default function SetupCard({ config, tz, onSaved, onSync, syncing }) {
  const [form, setForm] = useState({
    serpapiKey: '',
    placeId: config.placeIdSource === 'settings' ? config.placeId : '',
    autoSyncHours: config.autoSyncHours,
    fullSyncDays: config.fullSyncDays,
    companyName: config.companyName,
    reportTitle: config.reportTitle,
  });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState(null);

  useEffect(() => {
    setForm((f) => ({
      ...f,
      placeId: config.placeIdSource === 'settings' ? config.placeId : '',
      autoSyncHours: config.autoSyncHours,
      fullSyncDays: config.fullSyncDays,
      companyName: config.companyName,
      reportTitle: config.reportTitle,
    }));
  }, [config.placeId, config.placeIdSource, config.autoSyncHours, config.fullSyncDays, config.companyName, config.reportTitle]);

  async function run(label, fn) {
    setBusy(label);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  }

  const listingTotal = (config.listing && config.listing.total) || 800;
  const perIncremental = 1.5;
  const perFull = Math.ceil(listingTotal / 20) + 1;
  const monthly =
    (Number(form.autoSyncHours) > 0 ? (24 / Number(form.autoSyncHours)) * 30 * perIncremental : 0) +
    (Number(form.fullSyncDays) > 0 ? (30 / Number(form.fullSyncDays)) * perFull : 0);

  function save() {
    return run('save', async () => {
      const body = {
        placeId: form.placeId,
        autoSyncHours: Number(form.autoSyncHours),
        fullSyncDays: Number(form.fullSyncDays),
        companyName: form.companyName,
        reportTitle: form.reportTitle,
      };
      if (form.serpapiKey.trim()) body.serpapiKey = form.serpapiKey.trim();
      await api.patch('/api/reviews/config', body);
      setForm((f) => ({ ...f, serpapiKey: '' }));
      setMsg('Saved.');
      onSaved();
    });
  }

  function clearKey() {
    if (!confirm('Remove the stored SerpApi key? Syncs will fall back to SERPAPI_KEY in .env, if set.')) return;
    return run('save', async () => {
      await api.patch('/api/reviews/config', { serpapiKey: '' });
      setMsg('Stored key removed.');
      onSaved();
    });
  }

  function testConnection() {
    return run('test', async () => {
      setTest(null);
      const r = await api.post('/api/reviews/test-connection', form.serpapiKey.trim() ? { serpapiKey: form.serpapiKey.trim() } : {});
      setTest(r);
    });
  }

  function importJson(file) {
    if (!file) return;
    return run('import', async () => {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const r = await api.post('/api/reviews/import', payload);
      setMsg(`Imported ${plural(r.received, 'review')}: ${r.added} new, ${r.updated} updated · ${plural(r.stored, 'review')} stored.`);
      onSaved();
    });
  }

  const ls = config.lastSync;

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 4px' }}>Setup</h3>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Reviews are read from the public Google Maps listing through{' '}
        <a href="https://serpapi.com/google-maps-reviews-api" target="_blank" rel="noopener noreferrer">
          SerpApi
        </a>{' '}
        (no Google Business Profile approval needed). Each page of 20 reviews is one SerpApi search: a first
        full read of the listing is ~{perFull} searches, a routine sync 1–3.
      </div>

      <div className="row">
        <div style={{ flex: 2 }}>
          <label style={{ marginTop: 0 }}>
            SerpApi key{' '}
            {config.serpapiKeySet ? (
              <span className="badge ok" style={{ marginLeft: 6 }}>
                set {config.serpapiKeyHint} · from {config.serpapiKeySource === 'env' ? '.env' : 'settings'}
              </span>
            ) : (
              <span className="badge err" style={{ marginLeft: 6 }}>
                not set
              </span>
            )}
          </label>
          <input
            type="password"
            value={form.serpapiKey}
            onChange={(e) => setForm({ ...form, serpapiKey: e.target.value })}
            placeholder={config.serpapiKeySet ? 'Paste a new key to replace the stored one' : 'Paste your SerpApi key'}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div style={{ flex: 1, alignSelf: 'flex-end', display: 'flex', gap: 6 }}>
          <button type="button" className="secondary" onClick={testConnection} disabled={busy === 'test' || (!form.serpapiKey.trim() && !config.serpapiKeySet)}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {config.serpapiKeySource === 'settings' && (
            <button type="button" className="secondary" onClick={clearKey} disabled={busy === 'save'} title="Forget the stored key">
              Clear
            </button>
          )}
        </div>
      </div>
      {test && (
        <div className={`card alert ${test.ok ? 'alert-ok' : 'alert-err'}`} style={{ marginTop: 10, padding: '10px 14px' }}>
          {test.ok ? (
            <>
              Connected{test.email ? ` as ${test.email}` : ''} · plan <strong>{test.plan || '—'}</strong>
              {test.searchesLeft != null ? (
                <>
                  {' '}
                  · <strong>{Number(test.searchesLeft).toLocaleString()}</strong> searches left
                  {test.searchesPerMonth != null ? ` of ${Number(test.searchesPerMonth).toLocaleString()} / month` : ''}
                </>
              ) : null}
              {test.source === 'form' ? ' (the key in the box — save to keep it)' : ''}
            </>
          ) : (
            <>SerpApi rejected the key: {test.error || test.message}</>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 6 }}>
        <div style={{ flex: 2 }}>
          <label>
            Google Maps place_id{' '}
            <span className="muted" style={{ fontWeight: 400 }}>
              — blank uses {config.placeIdSource === 'env' ? 'GOOGLE_PLACE_ID from .env' : `the Treasure Hill - Corporate listing (${config.defaultPlaceId})`}
            </span>
          </label>
          <input value={form.placeId} onChange={(e) => setForm({ ...form, placeId: e.target.value })} placeholder={config.placeId} spellCheck={false} />
        </div>
        <div>
          <label>Auto-sync every (hours, 0 = manual only)</label>
          <input type="number" min="0" step="1" value={form.autoSyncHours} onChange={(e) => setForm({ ...form, autoSyncHours: e.target.value })} />
        </div>
        <div>
          <label>Full re-read every (days, 0 = never)</label>
          <input type="number" min="0" step="1" value={form.fullSyncDays} onChange={(e) => setForm({ ...form, fullSyncDays: e.target.value })} />
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        ≈ {Math.round(monthly).toLocaleString()} SerpApi searches a month with these settings. Incremental syncs only read the
        newest reviews; a full re-read also catches edits to old reviews.
        {config.lastFullSyncAt ? ` Last full read ${fmtDateTime(config.lastFullSyncAt, tz)}.` : ' No full read yet.'}
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <div>
          <label>Company name (deck cover)</label>
          <input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
        </div>
        <div>
          <label>Report title (deck cover)</label>
          <input value={form.reportTitle} onChange={(e) => setForm({ ...form, reportTitle: e.target.value })} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }}>
        <button type="button" onClick={save} disabled={busy === 'save'}>
          {busy === 'save' ? 'Saving…' : 'Save setup'}
        </button>
        <button type="button" className="secondary" onClick={() => onSync(true)} disabled={syncing || !config.serpapiKeySet} title="Re-read every review on the listing (~one search per 20 reviews)">
          {syncing ? 'Syncing…' : 'Full resync now'}
        </button>
        <label className="btn-link" style={{ margin: 0, cursor: busy === 'import' ? 'wait' : 'pointer' }} title="A JSON export: { reviews: [ { review_id, reviewer, rating, text, created_at, updated_at, link } ] }">
          {busy === 'import' ? 'Importing…' : 'Import reviews (JSON)'}
          <input type="file" accept="application/json,.json" style={{ display: 'none' }} disabled={busy === 'import'} onChange={(e) => importJson(e.target.files && e.target.files[0])} />
        </label>
        {msg && <span className={msg.startsWith('Error') ? 'error' : 'success'} style={{ margin: 0 }}>{msg}</span>}
      </div>

      {ls && ls.at && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Last sync {fmtDateTime(ls.at, tz)}: {ls.ok ? ls.message : `failed — ${ls.message}`}
          {ls.trigger ? ` (${ls.trigger.replace('manual:', 'by ')})` : ''}
        </div>
      )}
    </div>
  );
}

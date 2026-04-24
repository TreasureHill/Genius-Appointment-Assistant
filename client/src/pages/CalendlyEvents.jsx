import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

function MapRow({ entry, projects, onDone }) {
  const [projectId, setProjectId] = useState('');
  const [lots, setLots] = useState([]);
  const [lotId, setLotId] = useState('');
  const [addAsBuyer, setAddAsBuyer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!projectId) {
      setLots([]);
      setLotId('');
      return;
    }
    api.get(`/api/lots?project=${projectId}&limit=500`).then(setLots);
  }, [projectId]);

  async function submit() {
    if (!lotId) {
      setErr('Pick a lot first');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.post(`/api/calendly/unmatched/${entry._id}/map`, { lotId, addAsBuyer });
      onDone();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function ignore() {
    setBusy(true);
    try {
      await api.post(`/api/calendly/unmatched/${entry._id}/ignore`);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="nowrap">
        {entry.eventStartTime ? new Date(entry.eventStartTime).toLocaleString() : '—'}
      </td>
      <td>{entry.repName || entry.rep?.name || ''}</td>
      <td>
        <div><strong>{entry.inviteeName || '—'}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}>{entry.inviteeEmail}</div>
      </td>
      <td>{entry.eventName}</td>
      <td style={{ minWidth: 420 }}>
        <div className="row" style={{ gap: 6 }}>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Pick project…</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={lotId} onChange={(e) => setLotId(e.target.value)} disabled={!projectId}>
            <option value="">Pick lot…</option>
            {lots.map((l) => (
              <option key={l._id} value={l._id}>
                Lot {l.lotNumber}
                {l.address ? ` — ${l.address}` : ''}
              </option>
            ))}
          </select>
        </div>
        <label style={{ fontSize: 12, marginTop: 4 }}>
          <input type="checkbox" checked={addAsBuyer} onChange={(e) => setAddAsBuyer(e.target.checked)} />{' '}
          Add this email as a buyer on the lot (future events auto-match)
        </label>
        {err && <div className="error" style={{ fontSize: 12 }}>{err}</div>}
      </td>
      <td className="nowrap">
        <button onClick={submit} disabled={busy || !lotId}>
          Map
        </button>{' '}
        <button className="secondary" onClick={ignore} disabled={busy}>
          Ignore
        </button>
      </td>
    </tr>
  );
}

function ResolvedRow({ entry, onUnresolve, onDelete }) {
  return (
    <tr>
      <td className="nowrap">
        {entry.eventStartTime ? new Date(entry.eventStartTime).toLocaleString() : '—'}
      </td>
      <td>{entry.repName}</td>
      <td>
        <div><strong>{entry.inviteeName || '—'}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}>{entry.inviteeEmail}</div>
      </td>
      <td>{entry.eventName}</td>
      <td>
        {entry.status === 'mapped' && entry.mappedLot ? (
          <Link to={`/lots/${entry.mappedLot._id}`}>
            Lot {entry.mappedLot.lotNumber}
            {entry.mappedLot.project?.name ? ` · ${entry.mappedLot.project.name}` : ''}
          </Link>
        ) : (
          <span className="muted">ignored</span>
        )}
      </td>
      <td className="nowrap">
        <button className="secondary" onClick={() => onUnresolve(entry._id)}>
          Move back to unmatched
        </button>{' '}
        <button className="danger" onClick={() => onDelete(entry._id)}>
          Delete
        </button>
      </td>
    </tr>
  );
}

export default function CalendlyEvents() {
  const [tab, setTab] = useState('unmatched');
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  async function load() {
    const qs = new URLSearchParams({ status: tab });
    if (q) qs.set('q', q);
    const [list, projs] = await Promise.all([
      api.get(`/api/calendly/unmatched?${qs.toString()}`),
      api.get('/api/projects'),
    ]);
    setRows(list);
    setProjects(projs);
  }
  useEffect(() => {
    load();
  }, [tab]);

  async function syncNow() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.post('/api/settings/calendly/sync', {});
      if (r.ok) {
        setSyncMsg(
          `Synced: ${r.reps} reps, ${r.emailsSeen} invitees, ${r.matched.length} auto-matched, ${r.unmatched || 0} unmatched`
        );
      } else {
        setSyncMsg('Sync failed: ' + (r.message || 'unknown error'));
      }
      load();
    } catch (ex) {
      setSyncMsg('Sync error: ' + ex.message);
    } finally {
      setSyncing(false);
    }
  }

  async function unresolve(id) {
    await api.post(`/api/calendly/unmatched/${id}/unresolve`);
    load();
  }
  async function remove(id) {
    if (!confirm('Delete this entry? It will reappear if Calendly surfaces the invitee again.')) return;
    await api.del(`/api/calendly/unmatched/${id}`);
    load();
  }

  return (
    <div>
      <h1>Calendly events</h1>
      <p className="muted">
        Invitees that Calendly returned whose email didn't match any lot buyer. Map them to a lot
        here, or ignore them. Mapped entries flip the lot to <span className="badge scheduled">scheduled</span>
        and optionally add the invitee's email as a buyer so future events auto-match.
      </p>

      <div className="toolbar">
        <button onClick={() => setTab('unmatched')} className={tab === 'unmatched' ? '' : 'secondary'}>
          Unmatched
        </button>
        <button onClick={() => setTab('mapped')} className={tab === 'mapped' ? '' : 'secondary'}>
          Mapped
        </button>
        <button onClick={() => setTab('ignored')} className={tab === 'ignored' ? '' : 'secondary'}>
          Ignored
        </button>
        <input
          placeholder="Search email / name / event"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <button className="secondary" onClick={load}>
          Search
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={syncNow} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Calendly now'}
        </button>
      </div>
      {syncMsg && <div className="card">{syncMsg}</div>}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Event time</th>
              <th>Rep</th>
              <th>Invitee</th>
              <th>Event</th>
              <th>{tab === 'unmatched' ? 'Map to lot' : 'Mapped to'}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  {tab === 'unmatched'
                    ? 'Nothing unmatched right now. Click "Sync Calendly now" to refresh.'
                    : `No ${tab} entries.`}
                </td>
              </tr>
            )}
            {rows.map((r) =>
              tab === 'unmatched' ? (
                <MapRow key={r._id} entry={r} projects={projects} onDone={load} />
              ) : (
                <ResolvedRow key={r._id} entry={r} onUnresolve={unresolve} onDelete={remove} />
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

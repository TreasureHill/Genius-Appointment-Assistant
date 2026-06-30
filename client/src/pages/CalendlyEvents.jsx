import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import SearchableSelect from '../components/SearchableSelect.jsx';

function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function MapRow({ entry, projects, onDone, selected, onToggleSelect }) {
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
    api.get(`/api/lots?project=${projectId}&limit=500`).then((list) => {
      const sorted = [...list].sort((a, b) => naturalCmp(a.lotNumber, b.lotNumber));
      setLots(sorted);
    });
  }, [projectId]);

  const projectOptions = useMemo(
    () =>
      [...projects]
        .sort((a, b) => naturalCmp(a.name, b.name))
        .map((p) => ({ value: p._id, label: p.name })),
    [projects]
  );
  const lotOptions = useMemo(
    () =>
      lots.map((l) => ({
        value: l._id,
        label: `Lot ${l.lotNumber}${l.address ? ` — ${l.address}` : ''}`,
      })),
    [lots]
  );

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
      <td style={{ width: 32 }}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(entry._id)} />
      </td>
      <td className="nowrap">
        {entry.eventStartTime ? new Date(entry.eventStartTime).toLocaleString() : '—'}
      </td>
      <td>
        <div><strong>{entry.inviteeName || '—'}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}>{entry.inviteeEmail}</div>
        {entry.answer && (
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <span className="muted">Typed: </span>
            <strong>{entry.answer}</strong>
          </div>
        )}
      </td>
      <td>{entry.eventName}</td>
      <td style={{ minWidth: 420 }}>
        <div className="row" style={{ gap: 6 }}>
          <SearchableSelect
            value={projectId}
            onChange={(v) => setProjectId(v)}
            options={projectOptions}
            placeholder="Pick project…"
          />
          <SearchableSelect
            value={lotId}
            onChange={(v) => setLotId(v)}
            options={lotOptions}
            placeholder="Pick lot…"
            disabled={!projectId}
          />
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

function ResolvedRow({ entry, onUnresolve, onDelete, selected, onToggleSelect }) {
  return (
    <tr>
      <td style={{ width: 32 }}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(entry._id)} />
      </td>
      <td className="nowrap">
        {entry.eventStartTime ? new Date(entry.eventStartTime).toLocaleString() : '—'}
      </td>
      <td>
        <div><strong>{entry.inviteeName || '—'}</strong></div>
        <div className="muted" style={{ fontSize: 12 }}>{entry.inviteeEmail}</div>
        {entry.answer && (
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <span className="muted">Typed: </span>
            <strong>{entry.answer}</strong>
          </div>
        )}
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
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  async function load() {
    const qs = new URLSearchParams({ status: tab });
    if (q) qs.set('q', q);
    const [list, projs] = await Promise.all([
      api.get(`/api/calendly/unmatched?${qs.toString()}`),
      api.get('/api/projects'),
    ]);
    setRows(list);
    // Row set changed — drop any selection so we never act on rows that are no
    // longer visible (different tab, filtered out, or already resolved).
    setSelected(new Set());
    setProjects([...projs].sort((a, b) => naturalCmp(a.name, b.name)));
  }
  useEffect(() => {
    load();
  }, [tab]);

  // Tri-state header checkbox: checked when every visible row is selected,
  // indeterminate when only some are.
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r._id));
  const someSelected = rows.some((r) => selected.has(r._id));
  const selectAllRef = useRef(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allSelected && someSelected;
    }
  }, [allSelected, someSelected]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r._id))) return new Set();
      return new Set(rows.map((r) => r._id));
    });
  }

  async function syncNow() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.post('/api/settings/calendly/sync', {});
      if (r.ok) {
        const bySignal = r.bySignal || 0;
        setSyncMsg(
          `Synced: ${r.events} events, ${r.emailsSeen} invitees, ${r.matched.length} auto-matched` +
            (bySignal ? ` (${bySignal} by typed project/lot or name)` : '') +
            `, ${r.unmatched || 0} unmatched`
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

  async function bulkAction(action) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      action === 'delete' &&
      !confirm(
        `Delete ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}? They will reappear if Calendly surfaces the invitee again.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    try {
      await api.post('/api/calendly/unmatched/bulk', { ids, action });
      await load();
    } catch (ex) {
      alert('Bulk action failed: ' + ex.message);
    } finally {
      setBulkBusy(false);
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
        Invitees Calendly couldn't auto-match to a single lot — not by email, by the project/lot
        they typed at booking, nor by name. Map them to a lot here, or ignore them. Mapped entries
        flip the lot to <span className="badge scheduled">scheduled</span> and optionally add the
        invitee's email as a buyer so future events auto-match.
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

      {selected.size > 0 && (
        <div className="toolbar">
          <strong style={{ fontSize: 13 }}>{selected.size} selected</strong>
          <button className="secondary" onClick={() => setSelected(new Set())} disabled={bulkBusy}>
            Clear
          </button>
          <div style={{ flex: 1 }} />
          {tab === 'unmatched' && (
            <button className="secondary" onClick={() => bulkAction('ignore')} disabled={bulkBusy}>
              Ignore selected
            </button>
          )}
          {tab !== 'unmatched' && (
            <button className="secondary" onClick={() => bulkAction('unresolve')} disabled={bulkBusy}>
              Move back to unmatched
            </button>
          )}
          <button className="danger" onClick={() => bulkAction('delete')} disabled={bulkBusy}>
            Delete selected
          </button>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={rows.length === 0}
                  title="Select all"
                />
              </th>
              <th>Event time</th>
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
                <MapRow
                  key={r._id}
                  entry={r}
                  projects={projects}
                  onDone={load}
                  selected={selected.has(r._id)}
                  onToggleSelect={toggleSelect}
                />
              ) : (
                <ResolvedRow
                  key={r._id}
                  entry={r}
                  onUnresolve={unresolve}
                  onDelete={remove}
                  selected={selected.has(r._id)}
                  onToggleSelect={toggleSelect}
                />
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

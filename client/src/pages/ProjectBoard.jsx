import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';
import Pagination from '../components/Pagination.jsx';

const STATUSES = ['pending', 'contacted', 'scheduled', 'completed', 'opted_out'];
const ROLE_LABELS = { buyer: 'Buyer', coBuyer: 'Co-buyer', thirdBuyer: 'Third buyer' };

function BuyerCell({ buyer }) {
  if (!buyer || (!buyer.name && !buyer.email && !buyer.phone)) {
    return <span className="muted">—</span>;
  }
  return (
    <div>
      <div>
        <strong>{buyer.name || <span className="muted">(no name)</span>}</strong>
        {buyer.optedOut && (
          <span className="badge opted_out" style={{ marginLeft: 6 }}>
            opted out
          </span>
        )}
      </div>
      {buyer.email && (
        <div className="muted" style={{ fontSize: 12 }}>
          <a href={`mailto:${buyer.email}`}>{buyer.email}</a>
        </div>
      )}
      {buyer.phone && (
        <div className="muted" style={{ fontSize: 12 }}>
          {buyer.phone}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, active, onClick }) {
  return (
    <div
      className="tile"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        borderColor: active ? 'var(--primary)' : 'var(--border)',
        borderWidth: active ? 2 : 1,
      }}
    >
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
    </div>
  );
}

function parseIds(str) {
  if (!str) return [];
  return String(str).split(',').map((s) => s.trim()).filter(Boolean);
}

export default function ProjectBoard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialIds = parseIds(searchParams.get('project') || localStorage.getItem('board:project') || '');
  const [projects, setProjects] = useState([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => new Set(initialIds));
  const [maxReminders, setMaxReminders] = useState(null);
  const [lots, setLots] = useState([]);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [selected, setSelected] = useState(new Set());
  const [busyLotId, setBusyLotId] = useState(null);
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    api
      .get('/api/projects')
      .then((list) => {
        // Defend against a non-array payload (error envelope, proxy HTML, etc.):
        // projects.map runs during render, so a bad shape here would otherwise
        // throw and blank the page.
        const arr = Array.isArray(list) ? list : [];
        setProjects(arr);
        setLoadError('');
        // Reconcile any saved selection (URL / localStorage) against the projects
        // that actually exist. Without this, a deleted or stale project id leaves
        // the board querying a phantom project — empty table, nothing highlighted,
        // yet the header still claims "1/N selected".
        setSelectedProjectIds((prev) => {
          const valid = new Set(arr.map((p) => p._id));
          const pruned = new Set(Array.from(prev).filter((id) => valid.has(id)));
          if (pruned.size > 0) return pruned;
          // Nothing valid selected → default to the first project on a fresh visit.
          return arr.length ? new Set([arr[0]._id]) : new Set();
        });
      })
      .catch((e) => setLoadError('Could not load projects: ' + e.message));
    api
      .get('/api/settings')
      .then((s) => setMaxReminders(s?.schedule?.maxReminders ?? null))
      .catch(() => {});
  }, []);

  const selectedIdsKey = Array.from(selectedProjectIds).sort().join(',');

  useEffect(() => {
    if (!selectedIdsKey) {
      setLots([]);
      setSelected(new Set());
      localStorage.setItem('board:project', '');
      setSearchParams({}, { replace: true });
      return;
    }
    localStorage.setItem('board:project', selectedIdsKey);
    setSearchParams({ project: selectedIdsKey }, { replace: true });
    api
      .get(`/api/lots?projects=${selectedIdsKey}&limit=1000`)
      .then((l) => {
        setLots(Array.isArray(l) ? l : []);
        setSelected(new Set());
        setLoadError('');
      })
      .catch((e) => {
        setLots([]);
        setLoadError('Could not load lots: ' + e.message);
      });
  }, [selectedIdsKey]);

  function toggleProjectId(id) {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllProjects() {
    setSelectedProjectIds(new Set(projects.map((p) => p._id)));
  }
  function clearProjects() {
    setSelectedProjectIds(new Set());
  }

  const projectById = useMemo(() => new Map(projects.map((p) => [String(p._id), p])), [projects]);
  const showProjectCol = selectedProjectIds.size !== 1;
  const singleProject = selectedProjectIds.size === 1
    ? projectById.get(Array.from(selectedProjectIds)[0])
    : null;

  const byStatus = useMemo(() => {
    const m = { pending: 0, contacted: 0, scheduled: 0, completed: 0, opted_out: 0 };
    for (const l of lots) m[l.status] = (m[l.status] || 0) + 1;
    return m;
  }, [lots]);

  const filtered = useMemo(() => {
    return lots.filter((l) => {
      if (filter.status && l.status !== filter.status) return false;
      if (filter.q) {
        const q = filter.q.toLowerCase();
        const hay = [
          l.lotNumber,
          l.address,
          ...(l.buyers || []).flatMap((b) => [b.name, b.email, b.phone]),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [lots, filter]);

  // Paginate the filtered rows client-side. The status tiles and bulk actions
  // still operate on the full `lots` / `filtered` sets — only the rendered
  // table is sliced, so big projects don't paint thousands of rows at once.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, currentPage, pageSize]);

  // Snap back to page 1 whenever the filter or project selection changes, so a
  // narrower result set never strands the user on an empty high page.
  useEffect(() => {
    setPage(1);
  }, [filter.status, filter.q, selectedIdsKey]);

  // Select-all / indeterminate reflect the CURRENT PAGE's rows.
  const allSelected = paged.length > 0 && paged.every((l) => selected.has(l._id));
  const someSelected = paged.some((l) => selected.has(l._id));

  // Drive the tri-state header checkbox: checked when every visible row is
  // selected, indeterminate when only some are. NOTE: this hook must live
  // ABOVE the early return below — React requires the same hooks to run on
  // every render, and the "no projects" early return would otherwise skip it.
  const selectAllRef = useRef(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allSelected && someSelected;
    }
  }, [allSelected, someSelected]);

  async function changeStatus(lot, status) {
    setBusyLotId(lot._id);
    try {
      await api.post(`/api/lots/${lot._id}/status`, { status });
      setLots((prev) => prev.map((l) => (l._id === lot._id ? { ...l, status } : l)));
    } finally {
      setBusyLotId(null);
    }
  }

  async function deleteLot(lot) {
    if (!confirm(`Delete lot ${lot.lotNumber}? This removes the lot and any pending messages for it. Cannot be undone.`)) return;
    setBusyLotId(lot._id);
    try {
      await api.del(`/api/lots/${lot._id}`);
      setLots((prev) => prev.filter((l) => l._id !== lot._id));
      setSelected((prev) => {
        if (!prev.has(lot._id)) return prev;
        const next = new Set(prev);
        next.delete(lot._id);
        return next;
      });
    } catch (ex) {
      alert('Delete failed: ' + ex.message);
    } finally {
      setBusyLotId(null);
    }
  }

  async function deleteSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} lot${ids.length === 1 ? '' : 's'}? This also removes any pending messages for them. Cannot be undone.`)) return;
    try {
      const r = await api.post('/api/lots/bulk-delete', { ids });
      const idSet = new Set(ids);
      setLots((prev) => prev.filter((l) => !idSet.has(l._id)));
      setSelected(new Set());
      setSendMsg(`Deleted ${r.deleted} lot${r.deleted === 1 ? '' : 's'}.`);
    } catch (ex) {
      setSendMsg('Delete failed: ' + ex.message);
    }
  }

  function toggle(lotId) {
    const next = new Set(selected);
    if (next.has(lotId)) next.delete(lotId);
    else next.add(lotId);
    setSelected(next);
  }

  // Header checkbox selects/clears the rows on the CURRENT PAGE only, so it
  // never silently touches lots hidden by the filter or on another page.
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allVisibleSelected = paged.length > 0 && paged.every((l) => next.has(l._id));
      if (allVisibleSelected) {
        for (const l of paged) next.delete(l._id);
      } else {
        for (const l of paged) next.add(l._id);
      }
      return next;
    });
  }

  // Select every row across all pages that matches the current filter — handy
  // when paginated but you want the whole filtered set.
  function selectAllFiltered() {
    setSelected(new Set(filtered.map((l) => l._id)));
  }

  async function sendDefaults({ all = false } = {}) {
    setSendMsg('');
    setSending(true);
    try {
      let body;
      if (all) {
        const pendingIds = lots.filter((l) => l.status === 'pending').map((l) => l._id);
        if (pendingIds.length === 0) {
          setSendMsg('Nothing pending in the selected projects.');
          setSending(false);
          return;
        }
        body = { lotIds: pendingIds };
      } else {
        if (selected.size === 0) {
          setSendMsg('Pick lots first, or click "Send to all pending".');
          setSending(false);
          return;
        }
        body = { lotIds: Array.from(selected) };
      }
      const result = await api.post('/api/messages/send-defaults', body);
      const tplBits = [];
      if (result.usedEmail) tplBits.push(`email "${result.usedEmail.name}"`);
      if (result.usedSms) tplBits.push(`SMS "${result.usedSms.name}"`);

      // Per-lot counts of how many messages were queued, for optimistic UI.
      const queuedByLot = new Map();
      for (const q of result.queued) {
        queuedByLot.set(q.lotId, (queuedByLot.get(q.lotId) || 0) + 1);
      }
      const touchedCount = queuedByLot.size;

      setLots((prev) =>
        prev.map((l) => {
          const add = queuedByLot.get(String(l._id)) || 0;
          if (!add) return l;
          return {
            ...l,
            reminderCount: (l.reminderCount || 0) + 1,
            pendingMessages: (l.pendingMessages || 0) + add,
          };
        })
      );

      setSendMsg(
        `Queued ${result.queued.length} message${result.queued.length === 1 ? '' : 's'} across ` +
          `${touchedCount} lot${touchedCount === 1 ? '' : 's'} ` +
          `(${tplBits.join(' + ') || 'no templates configured'}). ` +
          (result.skipped.length
            ? `Skipped ${result.skipped.length} (already contacted / scheduled / opted out / duplicate / missing contact). `
            : '') +
          'They go out spread over minutes per your pacing settings — the row counters will update as each message sends.'
      );
      setSelected(new Set());

      // Short polling burst so the board reflects sends as they happen
      // without the user having to refresh manually.
      const key = selectedIdsKey;
      const startedAt = Date.now();
      async function refresh() {
        if (!key || key !== selectedIdsKey) return;
        try {
          const fresh = await api.get(`/api/lots?projects=${key}&limit=1000`);
          if (Array.isArray(fresh)) setLots(fresh);
        } catch {}
        if (Date.now() - startedAt < 60_000) {
          setTimeout(refresh, 5_000);
        }
      }
      setTimeout(refresh, 1_500);
    } catch (ex) {
      setSendMsg('Error: ' + ex.message);
    } finally {
      setSending(false);
    }
  }

  if (projects.length === 0) {
    return (
      <div>
        <h1>Board</h1>
        <div className="muted">
          No projects yet. <Link to="/import">Import a sheet</Link> to create lots under a project.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Board</h1>
        {singleProject && (
          <Link to={`/projects/${singleProject._id}`} className="muted" style={{ fontSize: 13 }}>
            {singleProject.name} settings →
          </Link>
        )}
        <div style={{ flex: 1 }} />
        <div className="muted" style={{ fontSize: 12 }}>
          Sending schedule lives in <Link to="/settings">Settings</Link>.
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Projects ({selectedProjectIds.size}/{projects.length}):</strong>
          <button
            className="secondary"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={selectAllProjects}
            disabled={selectedProjectIds.size === projects.length}
          >
            Select all
          </button>
          <button
            className="secondary"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={clearProjects}
            disabled={selectedProjectIds.size === 0}
          >
            Clear
          </button>
          <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
          {projects.map((p) => {
            const active = selectedProjectIds.has(p._id);
            return (
              <button
                key={p._id}
                className={active ? '' : 'secondary'}
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => toggleProjectId(p._id)}
                title={active ? 'Click to remove' : 'Click to add'}
              >
                {active ? '✓ ' : ''}
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {loadError && (
        <div className="card alert alert-err" style={{ marginTop: 12 }}>
          {loadError}
        </div>
      )}

      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile
          label="All lots"
          value={lots.length}
          active={!filter.status}
          onClick={() => setFilter({ ...filter, status: '' })}
        />
        {STATUSES.map((s) => (
          <Tile
            key={s}
            label={s.replace('_', ' ')}
            value={byStatus[s] || 0}
            active={filter.status === s}
            onClick={() => setFilter({ ...filter, status: filter.status === s ? '' : s })}
          />
        ))}
      </div>

      <div className="toolbar">
        <input
          placeholder="Search lot #, address, buyer name / email / phone…"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          style={{ flex: 1, minWidth: 240 }}
        />
        <div className="muted" style={{ fontSize: 12 }}>
          {filtered.length === lots.length
            ? `${lots.length} lot${lots.length === 1 ? '' : 's'}`
            : `${filtered.length} of ${lots.length} match`}{' '}
          · {selected.size} selected
          {selected.size < filtered.length && filtered.length > paged.length && (
            <>
              {' · '}
              <a
                role="button"
                onClick={selectAllFiltered}
                style={{ cursor: 'pointer' }}
                title="Select every lot matching the current filter, across all pages"
              >
                select all {filtered.length}
              </a>
            </>
          )}
        </div>
        <div style={{ flex: 1 }} />
        <button
          className="secondary"
          onClick={() => sendDefaults({ all: true })}
          disabled={sending || (byStatus.pending || 0) === 0}
          title="Sends the default email + SMS to every pending lot in this project. Already-contacted, scheduled, and opted-out lots are skipped."
        >
          Send to all pending ({byStatus.pending || 0})
        </button>
        <button onClick={() => sendDefaults({})} disabled={sending || selected.size === 0}>
          Send to {selected.size} selected
        </button>
        <button
          className="danger"
          onClick={deleteSelected}
          disabled={selected.size === 0}
          title="Permanently delete the selected lots and any pending messages for them"
        >
          Delete {selected.size} selected
        </button>
      </div>
      {sendMsg && (
        <div className={sendMsg.startsWith('Error') ? 'error' : 'card'} style={{ marginBottom: 10 }}>
          {sendMsg}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allSelected}
                  onChange={toggleAll}
                  title="Select all lots on this page"
                />
              </th>
              {showProjectCol && <th style={{ minWidth: 140 }}>Project</th>}
              <th style={{ minWidth: 70 }}>Lot #</th>
              <th style={{ minWidth: 140 }}>Address</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.buyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.coBuyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.thirdBuyer}</th>
              <th style={{ minWidth: 140 }}>Status</th>
              <th style={{ minWidth: 100 }}>Reminders</th>
              <th style={{ minWidth: 120 }}>Last contact</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((lot) => {
              const disabled = busyLotId === lot._id;
              return (
                <tr key={lot._id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(lot._id)}
                      onChange={() => toggle(lot._id)}
                    />
                  </td>
                  {showProjectCol && (
                    <td className="muted" style={{ fontSize: 12 }}>
                      {lot.project?.name || projectById.get(String(lot.project))?.name || ''}
                    </td>
                  )}
                  <td>
                    <Link to={`/lots/${lot._id}`}>
                      <strong>{lot.lotNumber}</strong>
                    </Link>
                  </td>
                  <td>{lot.address || <span className="muted">—</span>}</td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'buyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'coBuyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'thirdBuyer')} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={lot.status} />
                        {lot.pendingMessages > 0 && (
                          <span
                            className="badge pending"
                            title="Messages queued for this lot — they'll send over the next few minutes per pacing"
                            style={{ fontSize: 10 }}
                          >
                            {lot.pendingMessages} queued
                          </span>
                        )}
                      </div>
                      <select
                        value={lot.status}
                        onChange={(e) => changeStatus(lot, e.target.value)}
                        disabled={disabled}
                        style={{ fontSize: 12 }}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td>
                    {lot.reminderCount}
                    {maxReminders != null ? ` / ${maxReminders}` : ''}
                  </td>
                  <td className="muted nowrap">
                    {lot.lastContactedAt
                      ? new Date(lot.lastContactedAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="nowrap">
                    <Link to={`/lots/${lot._id}`}>
                      <button className="secondary">Open</button>
                    </Link>{' '}
                    <button
                      className="danger"
                      onClick={() => deleteLot(lot)}
                      disabled={disabled}
                      title="Delete this lot"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={showProjectCol ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {selectedProjectIds.size === 0
                    ? 'Select a project above to see its lots.'
                    : lots.length === 0
                      ? 'This project has no lots yet. Import a sheet to add some.'
                      : 'No lots match your filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <Pagination
          page={currentPage}
          pages={totalPages}
          total={filtered.length}
          pageSize={pageSize}
          noun="lots"
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>How sending works:</strong> Select lots above, pick a template, click <em>Send</em>.
        Each selected lot's buyers are queued with the project's pacing jitter. Once sent, the lot
        flips to <span className="badge contacted">contacted</span> and automatic reminders begin
        after the configured interval — until the lot is marked{' '}
        <span className="badge scheduled">scheduled</span> (manually, by Calendly match, or manual
        mapping) or <span className="badge opted_out">opted out</span>, or the max reminder count
        is reached.
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';

const STATUSES = ['pending', 'contacted', 'scheduled', 'booked', 'opted_out'];
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

export default function ProjectBoard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProject = searchParams.get('project') || localStorage.getItem('board:project') || '';
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(initialProject);
  const [project, setProject] = useState(null);
  const [lots, setLots] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [selected, setSelected] = useState(new Set());
  const [templateId, setTemplateId] = useState('');
  const [busyLotId, setBusyLotId] = useState(null);
  const [sendMsg, setSendMsg] = useState('');

  useEffect(() => {
    api.get('/api/projects').then((list) => {
      setProjects(list);
      if (!projectId && list.length) setProjectId(list[0]._id);
    });
    api.get('/api/templates').then(setTemplates);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    localStorage.setItem('board:project', projectId);
    setSearchParams({ project: projectId }, { replace: true });
    Promise.all([
      api.get(`/api/projects/${projectId}`),
      api.get(`/api/lots?project=${projectId}&limit=1000`),
    ]).then(([p, l]) => {
      setProject(p);
      setLots(l);
      setSelected(new Set());
    });
  }, [projectId]);

  const byStatus = useMemo(() => {
    const m = { pending: 0, contacted: 0, scheduled: 0, booked: 0, opted_out: 0 };
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

  async function changeStatus(lot, status) {
    setBusyLotId(lot._id);
    try {
      await api.post(`/api/lots/${lot._id}/status`, { status });
      setLots((prev) => prev.map((l) => (l._id === lot._id ? { ...l, status } : l)));
    } finally {
      setBusyLotId(null);
    }
  }

  function toggle(lotId) {
    const next = new Set(selected);
    if (next.has(lotId)) next.delete(lotId);
    else next.add(lotId);
    setSelected(next);
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((l) => l._id)));
    }
  }

  async function sendSelected() {
    setSendMsg('');
    if (!templateId || selected.size === 0) return;
    try {
      const result = await api.post('/api/messages/send', {
        lotIds: Array.from(selected),
        templateId,
      });
      setSendMsg(
        `Queued ${result.queued.length} message${result.queued.length === 1 ? '' : 's'} across ${
          selected.size
        } lot${selected.size === 1 ? '' : 's'}. ${
          result.skipped.length
            ? `Skipped ${result.skipped.length} — see reasons in the outbox.`
            : ''
        } Reminders will start ${project.reminderIntervalDays}d after each send, up to ${project.maxReminders}× per lot.`
      );
      setSelected(new Set());
      // Refresh lots to reflect contacted status after send
      setTimeout(async () => {
        const fresh = await api.get(`/api/lots?project=${projectId}&limit=1000`);
        setLots(fresh);
      }, 800);
    } catch (ex) {
      setSendMsg('Error: ' + ex.message);
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

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Board</h1>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          style={{ width: 'auto', minWidth: 240, fontSize: 15, fontWeight: 600 }}
        >
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        {project && (
          <Link to={`/projects/${project._id}`} className="muted" style={{ fontSize: 13 }}>
            settings →
          </Link>
        )}
        <div style={{ flex: 1 }} />
        {project && (
          <div className="muted" style={{ fontSize: 12 }}>
            reminder every {project.reminderIntervalDays}d · max {project.maxReminders} · pacing{' '}
            {project.pacing.minSec}–{project.pacing.maxSec}s
          </div>
        )}
      </div>

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
          Showing {filtered.length} of {lots.length} · {selected.size} selected
        </div>
        <div style={{ flex: 1 }} />
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Pick template…</option>
          {templates.map((t) => (
            <option key={t._id} value={t._id}>
              [{t.type}] {t.name}
            </option>
          ))}
        </select>
        <button onClick={sendSelected} disabled={!templateId || selected.size === 0}>
          Send to {selected.size} selected
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
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
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
            {filtered.map((lot) => {
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
                      <StatusBadge status={lot.status} />
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
                    {lot.reminderCount} / {project?.maxReminders ?? '–'}
                  </td>
                  <td className="muted nowrap">
                    {lot.lastContactedAt
                      ? new Date(lot.lastContactedAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="nowrap">
                    <Link to={`/lots/${lot._id}`}>
                      <button className="secondary">Open</button>
                    </Link>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {lots.length === 0
                    ? 'This project has no lots yet. Import a sheet to add some.'
                    : 'No lots match your filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>How sending works:</strong> Select lots above, pick a template, click <em>Send</em>.
        Each selected lot's buyers are queued with the project's pacing jitter. Once sent, the lot
        flips to <span className="badge contacted">contacted</span> and automatic reminders begin
        after the configured interval — until the lot is marked{' '}
        <span className="badge scheduled">scheduled</span> (manually, by Calendly match, or manual
        mapping) / <span className="badge booked">booked</span> /{' '}
        <span className="badge opted_out">opted out</span>, or the max reminder count is reached.
      </div>
    </div>
  );
}

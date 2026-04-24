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
  const [reps, setReps] = useState([]);
  const [filter, setFilter] = useState({ status: '', rep: '', q: '' });
  const [busyLotId, setBusyLotId] = useState(null);

  // Load projects + reps once
  useEffect(() => {
    api.get('/api/projects').then((list) => {
      setProjects(list);
      if (!projectId && list.length) {
        setProjectId(list[0]._id);
      }
    });
    api.get('/api/reps').then(setReps);
  }, []);

  // Load project + lots whenever project changes
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
      if (filter.rep) {
        const rep = l.assignedRep?._id || l.assignedRep;
        if (filter.rep === 'none' ? !!rep : String(rep) !== filter.rep) return false;
      }
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

  async function changeRep(lot, repId) {
    setBusyLotId(lot._id);
    try {
      const updated = await api.patch(`/api/lots/${lot._id}`, { assignedRep: repId || null });
      setLots((prev) =>
        prev.map((l) => (l._id === lot._id ? { ...l, assignedRep: updated.assignedRep } : l))
      );
    } finally {
      setBusyLotId(null);
    }
  }

  function buyerOf(lot, role) {
    return (lot.buyers || []).find((b) => b.role === role);
  }

  if (projects.length === 0) {
    return (
      <div>
        <h1>Board</h1>
        <div className="muted">
          No projects yet. Create one on the <Link to="/projects">Projects</Link> page or{' '}
          <Link to="/import">import a sheet</Link>.
        </div>
      </div>
    );
  }

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
          style={{ flex: 1, minWidth: 260 }}
        />
        <select value={filter.rep} onChange={(e) => setFilter({ ...filter, rep: e.target.value })}>
          <option value="">All reps</option>
          <option value="none">Unassigned</option>
          {reps.map((r) => (
            <option key={r._id} value={r._id}>
              {r.name}
            </option>
          ))}
        </select>
        <div className="muted" style={{ fontSize: 12 }}>
          Showing {filtered.length} of {lots.length}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 70 }}>Lot #</th>
              <th style={{ minWidth: 140 }}>Address</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.buyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.coBuyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.thirdBuyer}</th>
              <th style={{ minWidth: 140 }}>Rep</th>
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
                    <Link to={`/lots/${lot._id}`}>
                      <strong>{lot.lotNumber}</strong>
                    </Link>
                  </td>
                  <td>{lot.address || <span className="muted">—</span>}</td>
                  <td>
                    <BuyerCell buyer={buyerOf(lot, 'buyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={buyerOf(lot, 'coBuyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={buyerOf(lot, 'thirdBuyer')} />
                  </td>
                  <td>
                    <select
                      value={lot.assignedRep?._id || lot.assignedRep || ''}
                      onChange={(e) => changeRep(lot, e.target.value)}
                      disabled={disabled}
                    >
                      <option value="">— unassigned —</option>
                      {reps.map((r) => (
                        <option key={r._id} value={r._id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
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
                    ? 'This project has no lots yet. Import a sheet or add one from the project page.'
                    : 'No lots match your filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

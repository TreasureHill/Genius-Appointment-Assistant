import { useEffect, useState } from 'react';
import { api } from '../api';

const STATUS_LABELS = {
  pending: 'Pending',
  contacted: 'Contacted',
  scheduled: 'Scheduled',
  opted_out: 'Opted out',
};

const STATUS_KEYS = ['pending', 'contacted', 'scheduled', 'opted_out'];

function StatusBar({ byStatus, total }) {
  if (!total) return <div className="muted" style={{ fontSize: 12 }}>no lots</div>;
  const segs = STATUS_KEYS.map((s) => ({
    key: s,
    pct: ((byStatus[s] || 0) / total) * 100,
    n: byStatus[s] || 0,
  })).filter((s) => s.n > 0);
  return (
    <div
      style={{
        display: 'flex',
        height: 10,
        borderRadius: 999,
        overflow: 'hidden',
        background: '#f3f4f6',
        border: '1px solid var(--border)',
      }}
      title={segs.map((s) => `${STATUS_LABELS[s.key]}: ${s.n}`).join(' · ')}
    >
      {segs.map((s) => (
        <div
          key={s.key}
          className={`bar-seg seg-${s.key}`}
          style={{ width: `${s.pct}%` }}
          title={`${STATUS_LABELS[s.key]}: ${s.n}`}
        />
      ))}
    </div>
  );
}

export default function Reports() {
  const [data, setData] = useState(null);
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setErr('');
    try {
      const qs = project ? `?project=${project}` : '';
      const [d, p] = await Promise.all([
        api.get(`/api/reports/projects-by-status${qs}`),
        projects.length ? Promise.resolve(projects) : api.get('/api/projects'),
      ]);
      setData(d);
      if (!projects.length) setProjects(p);
    } catch (e) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    load();
  }, [project]);

  async function exportXlsx() {
    setBusy(true);
    try {
      const qs = project ? `?project=${project}` : '';
      const res = await api.raw(`/api/reports/projects-by-status/export${qs}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `genius-status-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <div className="error">{err}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const totals = data.totals || { total: 0 };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Reports</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Lot status across every project. Export an Excel report broken down by status.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={project} onChange={(e) => setProject(e.target.value)} style={{ minWidth: 220 }}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={exportXlsx} disabled={busy}>
            {busy ? 'Exporting…' : 'Export Excel report'}
          </button>
        </div>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">Total lots</div>
          <div className="value">{totals.total || 0}</div>
        </div>
        {STATUS_KEYS.map((s) => (
          <div key={s} className="tile">
            <div className="label">{STATUS_LABELS[s]}</div>
            <div className="value">{totals[s] || 0}</div>
          </div>
        ))}
      </div>

      <h2>Per project</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th style={{ minWidth: 200 }}>Status mix</th>
              <th>Total</th>
              {STATUS_KEYS.map((s) => (
                <th key={s}>{STATUS_LABELS[s]}</th>
              ))}
              <th>% Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {data.perProject.map((p) => {
              const total = p.totalLots || 0;
              const sched = p.byStatus?.scheduled || 0;
              const pct = total ? Math.round((sched / total) * 100) : 0;
              return (
                <tr key={p._id}>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>
                    <StatusBar byStatus={p.byStatus || {}} total={total} />
                  </td>
                  <td>{total}</td>
                  {STATUS_KEYS.map((s) => (
                    <td key={s}>{p.byStatus?.[s] || 0}</td>
                  ))}
                  <td>{pct}%</td>
                </tr>
              );
            })}
            {data.perProject.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No projects yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Generated {new Date(data.generatedAt).toLocaleString()}.
      </div>
    </div>
  );
}

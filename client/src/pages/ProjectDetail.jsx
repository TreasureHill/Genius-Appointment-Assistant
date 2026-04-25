import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState(null);
  const [lotCount, setLotCount] = useState(0);
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const [p, lots] = await Promise.all([
      api.get(`/api/projects/${id}`),
      api.get(`/api/lots?project=${id}&limit=500`),
    ]);
    setProject(p);
    setLotCount(lots.length);
  }

  useEffect(() => {
    load();
  }, [id]);

  async function save(e) {
    e.preventDefault();
    setSaved('');
    setErr('');
    try {
      const fd = new FormData(e.target);
      const updated = await api.patch(`/api/projects/${id}`, {
        name: fd.get('name'),
        description: fd.get('description'),
      });
      setProject(updated);
      setSaved('Saved.');
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function remove() {
    if (lotCount > 0) {
      alert('This project still has lots. Delete or move them first.');
      return;
    }
    if (!confirm('Delete this project? It has no lots, so this is safe.')) return;
    await api.del(`/api/projects/${id}`);
    nav('/projects');
  }

  async function downloadExport() {
    const res = await api.raw(`/api/sheets/export?project=${id}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9]/gi, '_')}-lots.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!project) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1>
        {project.name}{' '}
        <Link to="/projects" className="muted" style={{ fontSize: 13 }}>
          ← all projects
        </Link>{' '}
        <Link to={`/board?project=${project._id}`} style={{ fontSize: 13 }}>
          open on board →
        </Link>
      </h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Project</h2>
        <form onSubmit={save}>
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>Name</label>
              <input name="name" defaultValue={project.name} required />
            </div>
            <div style={{ flex: 3 }}>
              <label>Description</label>
              <input name="description" defaultValue={project.description || ''} />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={downloadExport}>
              Download lots (.xlsx)
            </button>
            <div style={{ flex: 1 }} />
            <button type="button" className="danger" onClick={remove}>
              Delete project
            </button>
          </div>
          {saved && <div className="success">{saved}</div>}
          {err && <div className="error">{err}</div>}
        </form>
      </div>

      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Pacing, reminder interval, max reminders, and default email/SMS templates are configured
          system-wide on the <Link to="/settings">Settings</Link> page (this is a single-owner
          system, so they apply to every project).
        </p>
      </div>

      <p className="muted">
        Lots for this project live on the <Link to={`/board?project=${project._id}`}>Board</Link>.
        From there you select lots and trigger the first send; reminders then run automatically on
        the schedule above.
      </p>
    </div>
  );
}

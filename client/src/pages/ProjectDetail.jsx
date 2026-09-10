import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [lotCount, setLotCount] = useState(0);
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');
  const [tplEmail, setTplEmail] = useState('');
  const [tplSms, setTplSms] = useState('');
  const [tplSaved, setTplSaved] = useState('');
  const [tplErr, setTplErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  async function load() {
    try {
      const [p, lots, tpls] = await Promise.all([
        api.get(`/api/projects/${id}`),
        api.get(`/api/lots?project=${id}&limit=500`),
        api.get('/api/templates'),
      ]);
      setProject(p);
      setLotCount(lots.length);
      setTemplates(tpls);
      setTplEmail(p.defaultEmailTemplate || '');
      setTplSms(p.defaultSmsTemplate || '');
      setLoadErr('');
    } catch (ex) {
      // Bad/stale id (404, cast error) or a network blip. Without this the
      // rejection is unhandled and the page shows "Loading…" forever.
      setLoadErr(ex.message || 'failed to load project');
    }
  }

  useEffect(() => {
    setProject(null);
    setLoadErr('');
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
        marketingName: fd.get('marketingName'),
        description: fd.get('description'),
      });
      setProject(updated);
      setSaved('Saved.');
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function saveTemplates() {
    setTplSaved('');
    setTplErr('');
    try {
      const updated = await api.patch(`/api/projects/${id}`, {
        defaultEmailTemplate: tplEmail || null,
        defaultSmsTemplate: tplSms || null,
      });
      setProject(updated);
      setTplSaved('Saved.');
    } catch (ex) {
      setTplErr(ex.message);
    }
  }

  const [remBusy, setRemBusy] = useState(false);
  const [remErr, setRemErr] = useState('');

  async function toggleReminders() {
    setRemErr('');
    setRemBusy(true);
    try {
      const updated = await api.patch(`/api/projects/${id}`, {
        remindersPaused: !project.remindersPaused,
      });
      setProject(updated);
    } catch (ex) {
      setRemErr(ex.message);
    } finally {
      setRemBusy(false);
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

  if (loadErr && !project) {
    return (
      <div>
        <h1>Project unavailable</h1>
        <div className="card">
          <p className="error" style={{ marginTop: 0 }}>
            Couldn't load this project: {loadErr}
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            It may have been deleted, or the link is stale.{' '}
            <Link to="/projects">← Back to all projects</Link>
          </p>
        </div>
      </div>
    );
  }
  if (!project) return <div className="muted">Loading…</div>;

  const emailTemplates = templates.filter((t) => t.type === 'email');
  const smsTemplates = templates.filter((t) => t.type === 'sms');

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
            <div style={{ flex: 2 }}>
              <label>Marketing name</label>
              <input
                name="marketingName"
                defaultValue={project.marketingName || ''}
                placeholder={project.name}
              />
            </div>
            <div style={{ flex: 3 }}>
              <label>Description</label>
              <input name="description" defaultValue={project.description || ''} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            The customer-facing name Aria speaks on calls (the <span className="kbd">{'{project_name}'}</span>{' '}
            variable in the Aria prompt). Leave blank to use the internal name above.
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
        <h2 style={{ marginTop: 0 }}>Default templates</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Pick which email and SMS templates this project uses for "send defaults" and automatic
          reminders. Leave blank to fall back to the system-wide defaults from{' '}
          <Link to="/settings">Settings</Link>.
        </p>
        <div className="row">
          <div>
            <label>Default email template</label>
            <select value={tplEmail} onChange={(e) => setTplEmail(e.target.value)}>
              <option value="">— use system default —</option>
              {emailTemplates.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Default SMS template</label>
            <select value={tplSms} onChange={(e) => setTplSms(e.target.value)}>
              <option value="">— use system default —</option>
              {smsTemplates.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={saveTemplates}>Save templates</button>
          {tplSaved && <span className="success">{tplSaved}</span>}
          {tplErr && <span className="error">{tplErr}</span>}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Reminders</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Automatic reminders for this project only. When paused, the scheduler skips this
          project's lots and any of its reminders already queued are held until you resume.
          Other projects are not affected, and manual sends from the Board still go through.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={toggleReminders}
            disabled={remBusy}
            className={project.remindersPaused ? '' : 'secondary'}
          >
            {project.remindersPaused ? 'Resume reminders' : 'Pause reminders'}
          </button>
          <span className={`badge ${project.remindersPaused ? 'err' : 'ok'}`}>
            {project.remindersPaused ? 'paused' : 'active'}
          </span>
          {remErr && <span className="error">{remErr}</span>}
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          Pacing, reminder interval, max reminders, send windows, the timezone, and the master
          reminder switch are configured system-wide on the <Link to="/settings">Settings</Link>{' '}
          page. Everything waiting to go out is listed on the <Link to="/queue">Queue</Link>.
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

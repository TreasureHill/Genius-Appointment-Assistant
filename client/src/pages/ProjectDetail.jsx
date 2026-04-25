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

  async function load() {
    const [p, t, lots] = await Promise.all([
      api.get(`/api/projects/${id}`),
      api.get('/api/templates'),
      api.get(`/api/lots?project=${id}&limit=1`),
    ]);
    setProject(p);
    setTemplates(t);
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
      const patch = {
        name: fd.get('name'),
        description: fd.get('description'),
        reminderIntervalDays: Number(fd.get('reminderIntervalDays')),
        maxReminders: Number(fd.get('maxReminders')),
        pacing: {
          minSec: Number(fd.get('pacingMin')),
          maxSec: Number(fd.get('pacingMax')),
        },
        quietHours: {
          enabled: fd.get('quietEnabled') === 'on',
          start: fd.get('quietStart') || '21:00',
          end: fd.get('quietEnd') || '08:00',
        },
        defaultEmailTemplate: fd.get('defaultEmail') || null,
        defaultSmsTemplate: fd.get('defaultSms') || null,
      };
      const updated = await api.patch(`/api/projects/${id}`, patch);
      setProject(updated);
      setSaved('Saved.');
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function remove() {
    if (lotCount > 0) {
      alert('This project has lots. Delete or move them first.');
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
        <h2 style={{ marginTop: 0 }}>Settings</h2>
        <form onSubmit={save}>
          <div className="row">
            <div style={{ flex: 2 }}>
              <label>Project name</label>
              <input name="name" defaultValue={project.name} required />
            </div>
            <div style={{ flex: 3 }}>
              <label>Description</label>
              <input name="description" defaultValue={project.description || ''} />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Reminder interval (days)</label>
              <input
                name="reminderIntervalDays"
                type="number"
                min="0"
                defaultValue={project.reminderIntervalDays}
              />
            </div>
            <div>
              <label>Max reminders</label>
              <input name="maxReminders" type="number" min="0" defaultValue={project.maxReminders} />
            </div>
            <div>
              <label>Pacing min (sec)</label>
              <input name="pacingMin" type="number" min="0" defaultValue={project.pacing.minSec} />
            </div>
            <div>
              <label>Pacing max (sec)</label>
              <input name="pacingMax" type="number" min="0" defaultValue={project.pacing.maxSec} />
            </div>
          </div>
          <div className="row">
            <div>
              <label>Default email template (for reminders)</label>
              <select name="defaultEmail" defaultValue={project.defaultEmailTemplate?._id || ''}>
                <option value="">— none —</option>
                {templates.filter((t) => t.type === 'email').map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Default SMS template (for reminders)</label>
              <select name="defaultSms" defaultValue={project.defaultSmsTemplate?._id || ''}>
                <option value="">— none —</option>
                {templates.filter((t) => t.type === 'sms').map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>
                <input
                  type="checkbox"
                  name="quietEnabled"
                  defaultChecked={project.quietHours?.enabled}
                />{' '}
                Quiet hours
              </label>
              <div className="row">
                <input name="quietStart" defaultValue={project.quietHours?.start || '21:00'} />
                <input name="quietEnd" defaultValue={project.quietHours?.end || '08:00'} />
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="submit">Save settings</button>
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

      <p className="muted">
        Lots for this project live on the <Link to={`/board?project=${project._id}`}>Board</Link>.
        From there you select lots and trigger the first send; reminders then run automatically on
        the schedule above.
      </p>
    </div>
  );
}

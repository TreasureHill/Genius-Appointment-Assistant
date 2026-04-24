import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';

export default function ProjectDetail() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [lots, setLots] = useState([]);
  const [reps, setReps] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [filter, setFilter] = useState({ rep: '', status: '', q: '' });
  const [selected, setSelected] = useState(new Set());
  const [templateId, setTemplateId] = useState('');
  const [saved, setSaved] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const [p, l, r, t] = await Promise.all([
      api.get(`/api/projects/${id}`),
      api.get(`/api/lots?project=${id}`),
      api.get('/api/reps'),
      api.get('/api/templates'),
    ]);
    setProject(p);
    setLots(l);
    setReps(r);
    setTemplates(t);
  }
  useEffect(() => {
    load();
  }, [id]);

  const filtered = useMemo(() => {
    return lots.filter((l) => {
      if (filter.rep) {
        const rep = l.assignedRep?._id || l.assignedRep;
        if (filter.rep === 'none' ? !!rep : String(rep) !== filter.rep) return false;
      }
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

  async function saveProject(e) {
    e.preventDefault();
    setSaved('');
    setErr('');
    try {
      const fd = new FormData(e.target);
      const patch = {
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

  function toggle(lotId) {
    const next = new Set(selected);
    if (next.has(lotId)) next.delete(lotId);
    else next.add(lotId);
    setSelected(next);
  }

  async function sendSelected() {
    if (!templateId || selected.size === 0) return;
    try {
      const result = await api.post('/api/messages/send', {
        lotIds: Array.from(selected),
        templateId,
      });
      alert(`Queued ${result.queued.length} messages, skipped ${result.skipped.length}.`);
      setSelected(new Set());
      load();
    } catch (ex) {
      alert(ex.message);
    }
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
        </Link>
      </h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Settings</h2>
        <form onSubmit={saveProject}>
          <div className="row">
            <div>
              <label>Reminder interval (days)</label>
              <input name="reminderIntervalDays" type="number" min="0" defaultValue={project.reminderIntervalDays} />
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
              <label>Default email template</label>
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
              <label>Default SMS template</label>
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
                <input type="checkbox" name="quietEnabled" defaultChecked={project.quietHours?.enabled} />{' '}
                Quiet hours
              </label>
              <div className="row">
                <input name="quietStart" defaultValue={project.quietHours?.start || '21:00'} />
                <input name="quietEnd" defaultValue={project.quietHours?.end || '08:00'} />
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="submit">Save settings</button>
            {saved && <span className="success" style={{ marginLeft: 10 }}>{saved}</span>}
            {err && <span className="error" style={{ marginLeft: 10 }}>{err}</span>}
          </div>
        </form>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Tools</h2>
        <div className="row" style={{ alignItems: 'end' }}>
          <div>
            <button onClick={downloadExport} className="secondary">
              Download project lots (.xlsx)
            </button>
          </div>
          <div>
            <Link to="/import">
              <button className="secondary">Import / add contacts</button>
            </Link>
          </div>
        </div>
      </div>

      <h2>Lots</h2>
      <div className="toolbar">
        <input
          placeholder="Search lots / buyers"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
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
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">All statuses</option>
          {['pending', 'contacted', 'scheduled', 'booked', 'opted_out'].map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Pick template to send…</option>
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

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}></th>
              <th>Lot #</th>
              <th>Address</th>
              <th>Buyers</th>
              <th>Rep</th>
              <th>Status</th>
              <th>Reminders</th>
              <th>Last contact</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l._id}>
                <td>
                  <input type="checkbox" checked={selected.has(l._id)} onChange={() => toggle(l._id)} />
                </td>
                <td>
                  <Link to={`/lots/${l._id}`}>{l.lotNumber}</Link>
                </td>
                <td>{l.address}</td>
                <td>
                  {(l.buyers || []).map((b, i) => (
                    <div key={i} style={{ fontSize: 12 }}>
                      <strong>{b.name || '—'}</strong>{' '}
                      <span className="muted">
                        {b.email} {b.phone}
                      </span>
                    </div>
                  ))}
                </td>
                <td>{l.assignedRep?.name || <span className="muted">—</span>}</td>
                <td>
                  <StatusBadge status={l.status} />
                </td>
                <td>
                  {l.reminderCount} / {project.maxReminders}
                </td>
                <td className="muted nowrap">
                  {l.lastContactedAt ? new Date(l.lastContactedAt).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No matching lots.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

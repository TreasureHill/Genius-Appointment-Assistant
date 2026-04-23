import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState('');
  const [description, setDesc] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const list = await api.get('/api/projects');
    setProjects(list);
  }
  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setErr('');
    try {
      await api.post('/api/projects', { name, description });
      setName('');
      setDesc('');
      load();
    } catch (ex) {
      setErr(ex.message);
    }
  }

  return (
    <div>
      <h1>Projects</h1>

      <div className="card">
        <form onSubmit={create}>
          <div className="row">
            <div>
              <label>New project name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label>Description (optional)</label>
              <input value={description} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div style={{ alignSelf: 'end' }}>
              <button type="submit">Create project</button>
            </div>
          </div>
          {err && <div className="error">{err}</div>}
        </form>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Lots</th>
              <th>Pending</th>
              <th>Scheduled</th>
              <th>Booked</th>
              <th>Reminders</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p._id}>
                <td>
                  <Link to={`/projects/${p._id}`}>{p.name}</Link>
                </td>
                <td>{p.stats.total}</td>
                <td>{p.stats.byStatus.pending || 0}</td>
                <td>{p.stats.byStatus.scheduled || 0}</td>
                <td>{p.stats.byStatus.booked || 0}</td>
                <td className="muted nowrap">
                  every {p.reminderIntervalDays}d · max {p.maxReminders}
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No projects yet. Create one above, or go to{' '}
                  <Link to="/import">Import / Export</Link> to upload a sheet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

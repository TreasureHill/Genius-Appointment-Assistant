import { useEffect, useState } from 'react';
import { api } from '../api';

function emptyForm() {
  return { name: '', email: '', phone: '', calendlyUser: '', notes: '' };
}

export default function Reps() {
  const [reps, setReps] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [editingId, setEditingId] = useState(null);
  const [err, setErr] = useState('');

  async function load() {
    const list = await api.get('/api/reps');
    setReps(list);
  }
  useEffect(() => {
    load();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    try {
      if (editingId) {
        await api.patch(`/api/reps/${editingId}`, form);
      } else {
        await api.post('/api/reps', form);
      }
      setForm(emptyForm());
      setEditingId(null);
      load();
    } catch (ex) {
      setErr(ex.message);
    }
  }

  function edit(r) {
    setEditingId(r._id);
    setForm({
      name: r.name || '',
      email: r.email || '',
      phone: r.phone || '',
      calendlyUser: r.calendlyUser || '',
      notes: r.notes || '',
    });
  }

  async function remove(id) {
    if (!confirm('Delete this rep? Only possible if no lots are assigned.')) return;
    try {
      await api.del(`/api/reps/${id}`);
      load();
    } catch (ex) {
      alert(ex.message);
    }
  }

  return (
    <div>
      <h1>Reps</h1>
      <p className="muted">
        Reps are tracking-only — they don't log in. Assign a rep to a lot from the lot editor or via
        the import sheet's <span className="kbd">Assigned Rep</span> column.
      </p>

      <div className="card">
        <form onSubmit={submit}>
          <div className="row">
            <div>
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label>Email</label>
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label>Phone</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label>Calendly user URI</label>
              <input
                placeholder="https://api.calendly.com/users/…"
                value={form.calendlyUser}
                onChange={(e) => setForm({ ...form, calendlyUser: e.target.value })}
              />
            </div>
          </div>
          <label>Notes</label>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {err && <div className="error">{err}</div>}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button type="submit">{editingId ? 'Update rep' : 'Add rep'}</button>
            {editingId && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm());
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Calendly</th>
              <th>Assigned lots</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r._id}>
                <td>{r.name}</td>
                <td>{r.email}</td>
                <td>{r.phone}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.calendlyUser ? '✓' : '—'}
                </td>
                <td>{r.lotCount}</td>
                <td className="nowrap">
                  <button className="secondary" onClick={() => edit(r)}>
                    Edit
                  </button>{' '}
                  <button className="danger" onClick={() => remove(r._id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {reps.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No reps yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

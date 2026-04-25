import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';

const ROLES = [
  { key: 'buyer', label: 'Buyer' },
  { key: 'coBuyer', label: 'Co-buyer' },
  { key: 'thirdBuyer', label: 'Third buyer' },
];
const STATUSES = ['pending', 'contacted', 'scheduled', 'booked', 'opted_out'];

function emptyBuyer(role) {
  return { role, name: '', email: '', phone: '', optedOut: false };
}

export default function LotDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    const [d, t] = await Promise.all([api.get(`/api/lots/${id}`), api.get('/api/templates')]);
    const buyers = ROLES.map(({ key }) => d.lot.buyers.find((b) => b.role === key) || emptyBuyer(key));
    setData({ ...d, lot: { ...d.lot, buyers } });
    setTemplates(t);
  }

  useEffect(() => {
    load();
  }, [id]);

  function setBuyer(idx, patch) {
    setData((prev) => {
      const buyers = prev.lot.buyers.map((b, i) => (i === idx ? { ...b, ...patch } : b));
      return { ...prev, lot: { ...prev.lot, buyers } };
    });
  }
  function setLot(patch) {
    setData((prev) => ({ ...prev, lot: { ...prev.lot, ...patch } }));
  }

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      // Drop buyers that are completely empty
      const buyers = data.lot.buyers.filter((b) => b.name || b.email || b.phone);
      const patch = {
        lotNumber: data.lot.lotNumber,
        address: data.lot.address,
        buyers,
        status: data.lot.status,
        notes: data.lot.notes || '',
      };
      const updated = await api.patch(`/api/lots/${id}`, patch);
      setMsg('Saved.');
      // Refresh to keep everything (history / queued) in sync
      setData((prev) => ({ ...prev, lot: { ...prev.lot, ...updated } }));
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    } finally {
      setSaving(false);
    }
  }

  async function quickStatus(s) {
    await api.post(`/api/lots/${id}/status`, { status: s });
    load();
  }

  async function sendNow(templateId) {
    if (!templateId) return;
    const result = await api.post(`/api/lots/${id}/send`, { templateId });
    alert(`Queued ${result.queued.length}, skipped ${result.skipped.length}`);
    load();
  }

  async function remove() {
    if (!confirm('Delete this lot? This cannot be undone.')) return;
    await api.del(`/api/lots/${id}`);
    window.location.href = `/projects/${data.lot.project._id}`;
  }

  if (!data) return <div className="muted">Loading…</div>;
  const { lot, history, queued } = data;

  return (
    <div>
      <h1>
        Lot {lot.lotNumber} <span className="muted" style={{ fontSize: 14 }}>· {lot.project?.name}</span>{' '}
        <Link to={`/projects/${lot.project?._id}`} className="muted" style={{ fontSize: 13 }}>
          ← project
        </Link>
      </h1>

      <div className="card">
        <div className="row">
          <div>
            <label>Lot #</label>
            <input value={lot.lotNumber} onChange={(e) => setLot({ lotNumber: e.target.value })} />
          </div>
          <div style={{ flex: 2 }}>
            <label>Address</label>
            <input value={lot.address || ''} onChange={(e) => setLot({ address: e.target.value })} />
          </div>
          <div>
            <label>Status</label>
            <select value={lot.status} onChange={(e) => setLot({ status: e.target.value })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>

        <h2>Buyers</h2>
        {lot.buyers.map((b, i) => (
          <div key={i} className="row" style={{ marginBottom: 8 }}>
            <div style={{ minWidth: 110 }}>
              <label>Role</label>
              <div style={{ padding: '8px 10px' }}>{ROLES[i]?.label || b.role}</div>
            </div>
            <div>
              <label>Name</label>
              <input value={b.name} onChange={(e) => setBuyer(i, { name: e.target.value })} />
            </div>
            <div>
              <label>Email</label>
              <input value={b.email} onChange={(e) => setBuyer(i, { email: e.target.value })} />
            </div>
            <div>
              <label>Phone</label>
              <input value={b.phone} onChange={(e) => setBuyer(i, { phone: e.target.value })} />
            </div>
            <div style={{ alignSelf: 'end' }}>
              <label>
                <input
                  type="checkbox"
                  checked={!!b.optedOut}
                  onChange={(e) => setBuyer(i, { optedOut: e.target.checked })}
                />{' '}
                Opted out
              </label>
            </div>
          </div>
        ))}

        <label>Notes</label>
        <textarea value={lot.notes || ''} onChange={(e) => setLot({ notes: e.target.value })} />

        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="secondary" onClick={() => quickStatus('booked')}>
            Mark booked (stops reminders)
          </button>
          <button className="secondary" onClick={() => quickStatus('opted_out')}>
            Mark opted out
          </button>
          <button className="secondary" onClick={() => quickStatus('pending')}>
            Reset to pending
          </button>
          <div style={{ flex: 1 }} />
          <button className="danger" onClick={remove}>
            Delete lot
          </button>
        </div>
        {msg && <div className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</div>}
        {lot.calendlyWarning && (
          <div className="error" style={{ marginTop: 8 }}>
            Calendly: {lot.calendlyWarning}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Send now</h2>
        <div className="muted" style={{ marginBottom: 6 }}>
          Reminder count: {lot.reminderCount}. Use this to push a one-off message to this lot.
        </div>
        <div className="row">
          <select id="sendNowTpl" defaultValue="">
            <option value="">Pick template…</option>
            {templates.map((t) => (
              <option key={t._id} value={t._id}>
                [{t.type}] {t.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => sendNow(document.getElementById('sendNowTpl').value)}
          >
            Queue send
          </button>
        </div>
      </div>

      {queued.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Queued ({queued.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>To</th>
                <th>Send after</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((q) => (
                <tr key={q._id}>
                  <td>{q.type}</td>
                  <td>{q.to}</td>
                  <td className="nowrap">{new Date(q.sendAfter).toLocaleString()}</td>
                  <td>
                    <StatusBadge status={q.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>History</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Dir</th>
              <th>To</th>
              <th>Subject / body</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h._id}>
                <td className="nowrap">{new Date(h.createdAt).toLocaleString()}</td>
                <td>{h.type}</td>
                <td>{h.direction}</td>
                <td>{h.to}</td>
                <td>{h.subject || h.body?.slice(0, 100)}</td>
                <td>
                  <span
                    className={`badge ${
                      h.status === 'sent' || h.status === 'received'
                        ? 'ok'
                        : h.status === 'failed'
                          ? 'err'
                          : 'pending'
                    }`}
                  >
                    {h.status}
                  </span>
                  {h.error && <div className="error" style={{ fontSize: 11 }}>{h.error}</div>}
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                  No messages yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

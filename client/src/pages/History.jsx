import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function History() {
  const [list, setList] = useState([]);
  const [projects, setProjects] = useState([]);
  const [filter, setFilter] = useState({ project: '', type: '', direction: '', status: '' });

  async function load() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) qs.append(k, v);
    const [l, p] = await Promise.all([
      api.get(`/api/messages/history?${qs.toString()}`),
      api.get('/api/projects'),
    ]);
    setList(l);
    setProjects(p);
  }

  useEffect(() => {
    load();
  }, [filter]);

  return (
    <div>
      <h1>Message history</h1>

      <div className="toolbar">
        <select value={filter.project} onChange={(e) => setFilter({ ...filter, project: e.target.value })}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="">All types</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="calendly">Calendly</option>
        </select>
        <select value={filter.direction} onChange={(e) => setFilter({ ...filter, direction: e.target.value })}>
          <option value="">In + out</option>
          <option value="out">Outbound</option>
          <option value="in">Inbound</option>
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Any status</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="received">Received</option>
          <option value="queued">Queued</option>
        </select>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Dir</th>
              <th>Project</th>
              <th>Lot</th>
              <th>To</th>
              <th>Subject / body</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((h) => (
              <tr key={h._id}>
                <td className="nowrap">{new Date(h.createdAt).toLocaleString()}</td>
                <td>{h.type}</td>
                <td>{h.direction}</td>
                <td>{h.project?.name}</td>
                <td>{h.lot ? <Link to={`/lots/${h.lot._id}`}>{h.lot.lotNumber}</Link> : ''}</td>
                <td>{h.to}</td>
                <td>{h.subject || h.body?.slice(0, 80)}</td>
                <td>
                  <span
                    className={`badge ${
                      h.status === 'sent' || h.status === 'received' ? 'ok' : h.status === 'failed' ? 'err' : 'pending'
                    }`}
                  >
                    {h.status}
                  </span>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No messages matched.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Pagination from '../components/Pagination.jsx';

export default function History() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState([]);
  const [filter, setFilter] = useState({
    project: '',
    type: '',
    direction: '',
    status: '',
    q: '',
  });

  async function load() {
    setLoading(true);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) qs.append(k, v);
    qs.append('page', String(page));
    qs.append('pageSize', String(pageSize));
    try {
      const [l, p] = await Promise.all([
        api.get(`/api/messages/history?${qs.toString()}`),
        projects.length ? Promise.resolve(projects) : api.get('/api/projects'),
      ]);
      setItems(l.items || []);
      setTotal(l.total || 0);
      setPages(l.pages || 1);
      if (!projects.length) setProjects(p);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filter.project, filter.type, filter.direction, filter.status, page, pageSize]);

  function setF(patch) {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Message history</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Every email, SMS, and Calendly match — with status and errors.
          </div>
        </div>
      </div>

      <div className="toolbar">
        <select value={filter.project} onChange={(e) => setF({ project: e.target.value })}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={filter.type} onChange={(e) => setF({ type: e.target.value })}>
          <option value="">All types</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="calendly">Calendly</option>
        </select>
        <select value={filter.direction} onChange={(e) => setF({ direction: e.target.value })}>
          <option value="">In + out</option>
          <option value="out">Outbound</option>
          <option value="in">Inbound</option>
        </select>
        <select value={filter.status} onChange={(e) => setF({ status: e.target.value })}>
          <option value="">Any status</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="received">Received</option>
          <option value="queued">Queued</option>
        </select>
        <input
          placeholder="Search recipient / subject / error…"
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && (setPage(1), load())}
          style={{ minWidth: 240 }}
        />
        <button className="secondary" onClick={() => (setPage(1), load())}>
          Search
        </button>
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
            {items.map((h) => (
              <tr key={h._id}>
                <td className="nowrap">{new Date(h.createdAt).toLocaleString()}</td>
                <td>{h.type}</td>
                <td>{h.direction}</td>
                <td>{h.project?.name}</td>
                <td>{h.lot ? <Link to={`/lots/${h.lot._id}`}>{h.lot.lotNumber}</Link> : ''}</td>
                <td className="nowrap" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.to}
                </td>
                <td style={{ maxWidth: 360 }}>
                  {h.subject || h.body?.slice(0, 80)}
                  {h.error && <div className="error" style={{ fontSize: 11, marginTop: 2 }}>{h.error}</div>}
                </td>
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
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No messages matched.
                </td>
              </tr>
            )}
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pages={pages}
        total={total}
        pageSize={pageSize}
        loading={loading}
        noun="messages"
        onPage={setPage}
        onPageSize={(n) => {
          setPageSize(n);
          setPage(1);
        }}
      />
    </div>
  );
}

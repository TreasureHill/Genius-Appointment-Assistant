import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

// Shared renderer for one unified activity row — used here and on the Dashboard.
export function ActivityRow({ item }) {
  const when = new Date(item.createdAt).toLocaleString();
  const lot = item.lot?._id ? (
    <Link to={`/lots/${item.lot._id}`}>{item.lot.lotNumber}</Link>
  ) : (
    ''
  );
  if (item.kind === 'event') {
    return (
      <tr>
        <td className="nowrap">{when}</td>
        <td>
          <span className="badge">status</span>
        </td>
        <td>{item.project?.name || ''}</td>
        <td>{lot}</td>
        <td colSpan={2}>
          {(item.fromStatus || '—').replace('_', ' ')} → {(item.toStatus || '—').replace('_', ' ')}
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {item.actorLabel}
            {item.message ? ` · ${item.message}` : ''}
          </span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className="nowrap">{when}</td>
      <td>
        {item.type}
        <span className="muted" style={{ fontSize: 11 }}>
          {' '}
          {item.direction}
        </span>
      </td>
      <td>{item.project?.name || ''}</td>
      <td>{lot}</td>
      <td className="nowrap" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {item.to}
      </td>
      <td style={{ maxWidth: 340 }}>
        {item.subject || item.body?.slice(0, 90)}
        {item.status && (
          <span
            className={`badge ${
              item.status === 'sent' || item.status === 'received'
                ? 'ok'
                : item.status === 'failed'
                  ? 'err'
                  : 'pending'
            }`}
            style={{ marginLeft: 8 }}
          >
            {item.status}
          </span>
        )}
        {item.error && <div className="error" style={{ fontSize: 11 }}>{item.error}</div>}
      </td>
    </tr>
  );
}

export default function Activity() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState([]);
  const [filter, setFilter] = useState({ project: '', kind: '', q: '' });

  async function load() {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter.project) qs.append('project', filter.project);
    if (filter.kind) qs.append('kind', filter.kind);
    if (filter.q) qs.append('q', filter.q);
    qs.append('page', String(page));
    qs.append('pageSize', String(pageSize));
    try {
      const l = await api.get(`/api/activity?${qs.toString()}`);
      setItems(l.items || []);
      setTotal(l.total || 0);
      setPages(l.pages || 1);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.get('/api/projects').then((p) => setProjects(Array.isArray(p) ? p : [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [filter.project, filter.kind, page, pageSize]);

  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(total, page * pageSize);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Activity log</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Every message, call, Calendly match, and status change across all lots.
          </div>
        </div>
      </div>

      <div className="toolbar">
        <select
          value={filter.project}
          onChange={(e) => {
            setFilter((f) => ({ ...f, project: e.target.value }));
            setPage(1);
          }}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={filter.kind}
          onChange={(e) => {
            setFilter((f) => ({ ...f, kind: e.target.value }));
            setPage(1);
          }}
        >
          <option value="">All activity</option>
          <option value="messages">Messages &amp; calls</option>
          <option value="events">Status changes</option>
        </select>
        <input
          placeholder="Search recipient / subject / note…"
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
        <table className="compact-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Project</th>
              <th>Lot</th>
              <th>To</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <ActivityRow key={it._id} item={it} />
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No activity yet.
                </td>
              </tr>
            )}
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <div className="muted" style={{ fontSize: 12 }}>
          {total === 0 ? 'No results' : `Showing ${startRow}–${endRow} of ${total.toLocaleString()}`}
        </div>
        <div style={{ flex: 1 }} />
        <label className="muted" style={{ fontSize: 12, margin: 0 }}>
          Per page&nbsp;
        </label>
        <select
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(1);
          }}
          style={{ width: 'auto' }}
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(1)}>
          « First
        </button>
        <button className="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
          ‹ Prev
        </button>
        <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
          Page {page} of {pages}
        </span>
        <button className="secondary" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
          Next ›
        </button>
        <button className="secondary" disabled={page >= pages || loading} onClick={() => setPage(pages)}>
          Last »
        </button>
      </div>
    </div>
  );
}

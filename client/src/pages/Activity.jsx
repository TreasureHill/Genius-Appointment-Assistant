import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { fmtDateTime, tzAbbrev } from '../time';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const TYPE_LABELS = { email: 'Email', sms: 'SMS', call: 'Call', calendly: 'Calendly' };

// One "Show" dropdown instead of the old Activity/History split.
const SHOW_OPTIONS = [
  { value: '', label: 'All activity' },
  { value: 'email', label: 'Emails' },
  { value: 'sms', label: 'Texts (SMS)' },
  { value: 'call', label: 'Aria calls' },
  { value: 'calendly', label: 'Calendly' },
  { value: 'inbound', label: 'Replies received' },
  { value: 'failed', label: 'Failed sends' },
  { value: 'events', label: 'Status changes' },
];
function showFromParams(sp) {
  if (sp.get('status') === 'failed') return 'failed';
  if (sp.get('kind') === 'events') return 'events';
  if (sp.get('direction') === 'in') return 'inbound';
  const type = sp.get('type');
  if (type && TYPE_LABELS[type]) return type;
  return sp.get('show') || '';
}
function applyShow(show, qs) {
  if (!show) return;
  if (show === 'events') qs.append('kind', 'events');
  else {
    qs.append('kind', 'messages');
    if (show === 'failed') qs.append('status', 'failed');
    else if (show === 'inbound') qs.append('direction', 'in');
    else qs.append('type', show);
  }
}

// Email bodies are stored as rendered HTML; show them as readable text.
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function statusClass(status) {
  if (status === 'sent' || status === 'received' || status === 'delivered') return 'ok';
  if (status === 'failed') return 'err';
  return 'pending';
}

// Lot cell: always a link when the lot still exists, otherwise say so instead
// of leaving the column blank.
function LotCell({ lot }) {
  if (lot?._id) {
    return (
      <Link to={`/lots/${lot._id}`} title={lot.address || ''}>
        Lot {lot.lotNumber}
      </Link>
    );
  }
  return <span className="muted">(lot deleted)</span>;
}

// Shared renderer for one unified activity row — used here and on the Dashboard.
// Click a row to expand the full detail (recipient, error, message body).
export function ActivityRow({ item }) {
  const [open, setOpen] = useState(false);
  const { timezone } = useTimezone();
  const fmt = (d) => fmtDateTime(d, timezone);
  const when = fmt(item.createdAt);
  const lot = <LotCell lot={item.lot} />;

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

  const failed = item.status === 'failed';
  const bodyText = item.type === 'email' ? stripHtml(item.body) : String(item.body || '');
  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer' }}
        title={open ? 'Hide details' : 'Show details'}
      >
        <td className="nowrap">{when}</td>
        <td className="nowrap">
          {TYPE_LABELS[item.type] || item.type}
          <span className="muted" style={{ fontSize: 11 }}>
            {' '}
            {item.direction === 'in' ? 'in' : 'out'}
          </span>
        </td>
        <td>{item.project?.name || ''}</td>
        <td onClick={(e) => e.stopPropagation()}>{lot}</td>
        <td style={{ maxWidth: 220, overflowWrap: 'anywhere' }}>{item.to || <span className="muted">—</span>}</td>
        <td style={{ maxWidth: 340 }}>
          {item.subject || bodyText.slice(0, 90) || <span className="muted">(no subject)</span>}
          {item.status && (
            <span className={`badge ${statusClass(item.status)}`} style={{ marginLeft: 8 }}>
              {item.status}
            </span>
          )}
          {failed && (
            <div className="error" style={{ fontSize: 11, margin: '2px 0 0' }}>
              {item.error ? String(item.error).slice(0, 160) : 'send failed'}
            </div>
          )}
          <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
            {open ? '▴ less' : '▾ details'}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="activity-detail">
          <td colSpan={6} style={{ background: 'var(--panel-subtle)', fontSize: 13 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', padding: '6px 4px' }}>
              <span className="muted">Lot</span>
              <span onClick={(e) => e.stopPropagation()}>
                {lot}
                {item.lot?.address ? <span className="muted"> · {item.lot.address}</span> : null}
                {item.project?.name ? <span className="muted"> · {item.project.name}</span> : null}
              </span>
              <span className="muted">{item.direction === 'in' ? 'From' : 'To'}</span>
              <span style={{ overflowWrap: 'anywhere' }}>
                {item.recipients && item.recipients.length > 0 ? (
                  item.recipients.map((r, i) => (
                    <span key={i}>
                      {i > 0 ? ', ' : ''}
                      {r.name ? `${r.name} · ` : ''}
                      {r.address}
                    </span>
                  ))
                ) : (
                  <>
                    {item.to || '—'}
                    {item.buyerIndex != null ? <span className="muted"> (buyer #{item.buyerIndex + 1})</span> : null}
                  </>
                )}
              </span>
              <span className="muted">Status</span>
              <span>
                <span className={`badge ${statusClass(item.status)}`}>{item.status || '—'}</span>
                {item.isReminder ? <span className="muted"> · reminder {item.reminderIndex || ''}</span> : null}
              </span>
              {failed && (
                <>
                  <span className="muted">Error</span>
                  <span className="error" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                    {item.error || 'No error text was recorded.'}
                  </span>
                </>
              )}
              {(item.scheduledFor || item.sentAt) && (
                <>
                  <span className="muted">Timing</span>
                  <span>
                    {item.scheduledFor ? `queued for ${fmt(item.scheduledFor)}` : ''}
                    {item.scheduledFor && item.sentAt ? ' · ' : ''}
                    {item.sentAt ? `sent ${fmt(item.sentAt)}` : ''}
                  </span>
                </>
              )}
              {item.subject && (
                <>
                  <span className="muted">Subject</span>
                  <span>{item.subject}</span>
                </>
              )}
              {bodyText && (
                <>
                  <span className="muted">Message</span>
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      maxHeight: 320,
                      overflow: 'auto',
                    }}
                  >
                    {bodyText}
                  </pre>
                </>
              )}
              {item.providerId && (
                <>
                  <span className="muted">Provider id</span>
                  <span className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                    {item.providerId}
                  </span>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
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
  const [searchParams] = useSearchParams();
  const { timezone } = useTimezone();
  // Deep links: /activity?status=failed (Dashboard), ?type=sms, ?kind=events…
  const [filter, setFilter] = useState({
    project: searchParams.get('project') || '',
    show: showFromParams(searchParams),
    q: searchParams.get('q') || '',
  });

  async function load() {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter.project) qs.append('project', filter.project);
    applyShow(filter.show, qs);
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
  }, [filter.project, filter.show, page, pageSize]);

  const startRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endRow = Math.min(total, page * pageSize);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Activity</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Every email, text, Aria call, Calendly match and status change across all lots — newest
            first. Click a row for the full message. Times in {timezone || 'your local zone'}
            {timezone ? ` (${tzAbbrev(timezone)})` : ''}. Waiting to go out? See the{' '}
            <Link to="/queue">Queue</Link>.
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
          value={filter.show}
          onChange={(e) => {
            setFilter((f) => ({ ...f, show: e.target.value }));
            setPage(1);
          }}
        >
          {SHOW_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Search recipient / subject / error / note…"
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

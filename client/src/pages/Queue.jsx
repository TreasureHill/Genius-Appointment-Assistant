import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { dateKey, fmtDateTime, fmtDayLabel, fmtTime, relativeTime, tzAbbrev } from '../time';

// The Queue tab: every email and text waiting in the outbox plus every Aria
// call waiting in the call queue, in the order they will happen, with the
// exact time each goes out in the sending-schedule timezone.

const HOLD_LABELS = {
  sender_paused: 'sending is paused',
  reminders_paused: 'all reminders paused',
  project_reminders_paused: 'project reminders paused',
};

function TypeBadge({ type }) {
  return <span className={`badge type-${type}`}>{type === 'sms' ? 'SMS' : 'Email'}</span>;
}

function Tile({ label, value, hint, active, onClick, accent }) {
  return (
    <div
      className={`tile${accent ? ` tile-${accent}` : ''}`}
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        borderColor: active ? 'var(--primary)' : undefined,
        borderWidth: active ? 2 : 1,
      }}
    >
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
      {hint && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function stop(e) {
  e.stopPropagation();
}

// Everyone one send goes to: the buyers on the lot (one email to all of them,
// or one text per phone). Names on top, addresses underneath.
function Recipients({ list }) {
  const people = list || [];
  if (!people.length) return <span className="muted">—</span>;
  const names = people.map((r) => r.name).filter(Boolean);
  return (
    <>
      {names.length > 0 && <div>{names.join(', ')}</div>}
      <div className="muted" style={{ fontSize: 12 }}>
        {people.map((r) => r.address).filter(Boolean).join(', ')}
      </div>
    </>
  );
}

function QueueRow({ it, tz, selected, onToggle, open, onOpen, detail, onSendNow, onCancel, busy }) {
  const due = new Date(it.sendAfter).getTime() <= Date.now();
  const pending = it.status === 'pending';
  let timing;
  if (it.status === 'sending') timing = <span className="badge pending">sending…</span>;
  else if (it.hold) timing = <span className="badge err">held · {HOLD_LABELS[it.hold] || it.hold}</span>;
  else if (it.sendNow) timing = <span className="badge ok">send now</span>;
  else if (due) timing = <span className="muted">due now</span>;
  else timing = <span className="muted">{relativeTime(it.sendAfter)}</span>;

  return (
    <>
      <tr onClick={onOpen} style={{ cursor: 'pointer' }} title={open ? 'Hide the message' : 'Show the full message'}>
        <td onClick={stop}>
          <input type="checkbox" checked={selected} onChange={onToggle} disabled={!pending} />
        </td>
        <td className="nowrap">
          <strong>{fmtTime(it.sendAfter, tz)}</strong>
          <div style={{ fontSize: 11, marginTop: 2 }}>{timing}</div>
        </td>
        <td>
          <TypeBadge type={it.type} />
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {it.project?.name || ''}
        </td>
        <td onClick={stop}>
          {it.lot?.deleted ? (
            <span className="muted">(lot deleted)</span>
          ) : (
            <Link to={`/lots/${it.lot._id}`}>Lot {it.lot.lotNumber}</Link>
          )}
          {it.lot?.address && (
            <div className="muted" style={{ fontSize: 11 }}>
              {it.lot.address}
            </div>
          )}
        </td>
        <td style={{ minWidth: 170, maxWidth: 260, overflowWrap: 'anywhere' }}>
          <Recipients list={it.recipients} />
        </td>
        <td style={{ maxWidth: 360 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
            {it.subject || it.preview || <span className="muted">(empty message)</span>}
          </div>
          {it.template && (
            <div className="muted" style={{ fontSize: 11 }}>
              template: {it.template.name}
            </div>
          )}
        </td>
        <td className="nowrap">
          {it.isReminder ? (
            <span className="badge contacted">reminder #{it.reminderIndex || 1}</span>
          ) : (
            <span className="badge pending">first send</span>
          )}
          {it.attempts > 0 && it.lastError && (
            <div className="error" style={{ fontSize: 11, margin: '2px 0 0', maxWidth: 200 }}>
              retry: {String(it.lastError).slice(0, 80)}
            </div>
          )}
        </td>
        <td className="nowrap" onClick={stop}>
          <button
            className="secondary small"
            disabled={busy || !pending || it.sendNow}
            onClick={onSendNow}
            title="Skip the send window and pacing — goes out on the next worker tick"
          >
            Send now
          </button>{' '}
          <button className="danger small" disabled={busy || !pending} onClick={onCancel} title="Remove this message from the queue">
            Cancel
          </button>
        </td>
      </tr>
      {open && (
        <tr className="queue-detail">
          <td colSpan={9} style={{ background: 'var(--panel-subtle)', fontSize: 13 }}>
            {!detail ? (
              <span className="muted">Loading message…</span>
            ) : (
              <div className="detail-grid">
                <span className="muted">Goes out</span>
                <span>
                  {fmtDateTime(it.sendAfter, tz)} {tzAbbrev(tz, it.sendAfter)}
                  <span className="muted"> · queued {fmtDateTime(it.createdAt, tz)}</span>
                </span>
                <span className="muted">To</span>
                <span style={{ overflowWrap: 'anywhere' }}>
                  {(it.recipients || []).map((r, i) => (
                    <span key={i}>
                      {i > 0 ? ', ' : ''}
                      {r.name ? `${r.name} · ` : ''}
                      {r.address}
                      {r.role ? <span className="muted"> ({r.role === 'coBuyer' ? 'co-buyer' : r.role === 'thirdBuyer' ? 'third buyer' : 'buyer'})</span> : null}
                    </span>
                  ))}
                  {it.rows > 1 && (
                    <span className="muted"> — {it.rows} {it.type === 'sms' ? 'texts, one per phone' : 'emails'}, sent together</span>
                  )}
                </span>
                {detail.template && (
                  <>
                    <span className="muted">Template</span>
                    <span>
                      <Link to={`/templates/${detail.template._id}`}>{detail.template.name}</Link>
                    </span>
                  </>
                )}
                {detail.subject && (
                  <>
                    <span className="muted">Subject</span>
                    <span>{detail.subject}</span>
                  </>
                )}
                <span className="muted">Message</span>
                <div>
                  {it.rows > 1 && (
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      Personalised per recipient — showing the first.
                    </div>
                  )}
                  <pre className="message-pre">{detail.bodyText || detail.text || '(empty)'}</pre>
                </div>
                {detail.lastError && (
                  <>
                    <span className="muted">Last error</span>
                    <span className="error" style={{ margin: 0 }}>
                      {detail.lastError}
                    </span>
                  </>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Queue() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { timezone: ctxTz } = useTimezone();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [projects, setProjects] = useState([]);
  const [type, setType] = useState(searchParams.get('type') || '');
  const [project, setProject] = useState(searchParams.get('project') || '');
  const [lotFilter, setLotFilter] = useState(searchParams.get('lot') || '');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({});
  const selectAllRef = useRef(null);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      const qs = new URLSearchParams();
      if (project) qs.set('project', project);
      if (type) qs.set('type', type);
      if (lotFilter) qs.set('lot', lotFilter);
      try {
        const d = await api.get(`/api/queue?${qs.toString()}`);
        setData(d);
        setErr('');
      } catch (e) {
        if (!quiet) setErr(e.message);
      }
    },
    [project, type, lotFilter]
  );

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    api.get('/api/projects').then((p) => setProjects(Array.isArray(p) ? p : [])).catch(() => {});
  }, []);
  useEffect(() => {
    const next = {};
    if (project) next.project = project;
    if (type) next.type = type;
    if (lotFilter) next.lot = lotFilter;
    setSearchParams(next, { replace: true });
  }, [project, type, lotFilter, setSearchParams]);

  // Keep the page live while anything is waiting or a call is in progress.
  const live = !!data && (data.counts?.total > 0 || data.calls?.activeCount > 0 || data.calls?.queuedCount > 0);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => {
      if (!document.hidden) load({ quiet: true });
    }, 10000);
    return () => clearInterval(t);
  }, [live, load]);

  const tz = data?.timezone || ctxTz;

  const items = useMemo(() => {
    const all = data?.items || [];
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter((it) =>
      [it.to, it.subject, it.preview, ...(it.recipients || []).map((r) => r.name), it.lot?.lotNumber, it.lot?.address, it.project?.name, it.template?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [data, q]);

  const groups = useMemo(() => {
    const out = [];
    const now = new Date();
    let cur = null;
    for (const it of items) {
      const key = dateKey(it.sendAfter, tz);
      if (!cur || cur.key !== key) {
        cur = { key, label: fmtDayLabel(it.sendAfter, tz, now), items: [] };
        out.push(cur);
      }
      cur.items.push(it);
    }
    return out;
  }, [items, tz]);

  const pendingShown = items.filter((i) => i.status === 'pending');
  const allSelected = pendingShown.length > 0 && pendingShown.every((i) => selected.has(i.key));
  const someSelected = pendingShown.some((i) => selected.has(i.key));
  const idsOf = (list) => list.flatMap((i) => i.ids || [String(i._id)]);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = !allSelected && someSelected;
  }, [allSelected, someSelected]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const i of pendingShown) next.delete(i.key);
      else for (const i of pendingShown) next.add(i.key);
      return next;
    });
  }

  async function run(fn, okText) {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      setMsg(typeof okText === 'function' ? okText(r) : okText);
      setSelected(new Set());
      await load({ quiet: true });
    } catch (e) {
      setMsg('Error: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const who = (it) => `Lot ${it.lot?.lotNumber || ''} (${(it.recipients || []).map((r) => r.name || r.address).join(', ')})`;
  function sendNow(it) {
    return run(
      () => api.post('/api/queue/send-now', { ids: it.ids }),
      `Sending the ${it.type === 'sms' ? 'text' : 'email'} for ${who(it)} now — it goes out within a few seconds.`
    );
  }
  function cancelOne(it) {
    return run(() => api.post('/api/queue/cancel', { ids: it.ids }), `Cancelled the ${it.type === 'sms' ? 'text' : 'email'} for ${who(it)}.`);
  }
  function cancelSelected() {
    const chosen = pendingShown.filter((i) => selected.has(i.key));
    if (!chosen.length) return;
    if (!confirm(`Cancel ${plural(chosen.length, 'queued message')}? They will not be sent.`)) return;
    return run(() => api.post('/api/queue/cancel', { ids: idsOf(chosen) }), () => `Cancelled ${plural(chosen.length, 'message')}.`);
  }
  function cancelShown() {
    if (!pendingShown.length) return;
    if (!confirm(`Cancel all ${plural(pendingShown.length, 'queued message')} shown? They will not be sent.`)) return;
    return run(() => api.post('/api/queue/cancel', { ids: idsOf(pendingShown) }), () => `Cancelled ${plural(pendingShown.length, 'message')}.`);
  }
  function replan() {
    return run(
      () => api.post('/api/queue/replan'),
      (r) =>
        r.total === 0
          ? 'Nothing queued to re-plan.'
          : `Re-planned ${plural(r.total, 'message')} (${r.moved} moved). First goes out ${fmtDateTime(r.firstSendAt, tz)}, last ${fmtDateTime(r.lastSendAt, tz)}.`
    );
  }
  function togglePause() {
    const paused = !data.schedule.senderPaused;
    return run(
      () => api.post('/api/settings/pause', { paused }),
      paused ? 'Sending paused. Messages stay queued until you resume.' : 'Sending resumed.'
    );
  }
  function clearCalls() {
    if (!confirm('Clear every queued call? The call already in progress finishes.')) return;
    return run(() => api.del('/api/calls/queue'), (r) => `Cleared ${plural(r.cancelled, 'queued call')}.`);
  }
  function cancelCall(item) {
    return run(() => api.del(`/api/calls/queue/${item._id}`), `Removed Lot ${item.lot?.lotNumber || ''} from the call queue.`);
  }

  async function openRow(it) {
    const key = it.key;
    if (openId === key) {
      setOpenId(null);
      return;
    }
    setOpenId(key);
    if (!details[key]) {
      try {
        const d = await api.get(`/api/queue/${it.ids[0]}`);
        setDetails((prev) => ({ ...prev, [key]: d }));
      } catch (e) {
        setDetails((prev) => ({ ...prev, [key]: { bodyText: `Could not load: ${e.message}` } }));
      }
    }
  }

  if (err && !data) return <div className="error">{err}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  const sched = data.schedule || {};
  const counts = data.counts || {};
  const calls = data.calls || { active: null, pending: [], queuedCount: 0, activeCount: 0 };
  const today = data.today || {};
  const lotFiltered = lotFilter ? items[0]?.lot : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Queue</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            Every email, text and Aria call waiting to go out, in the order it will happen. Times are in{' '}
            <strong>{tz}</strong> ({tzAbbrev(tz)}).
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className={sched.senderPaused ? '' : 'secondary'} onClick={togglePause} disabled={busy}>
            {sched.senderPaused ? '▶ Resume sending' : '❚❚ Pause sending'}
          </button>
          <button className="secondary" onClick={replan} disabled={busy || counts.total === 0} title="Re-space everything queued from now using the current pacing and send windows">
            Re-plan queue
          </button>
          <button className="secondary" onClick={() => load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card queue-strip">
        <div className="strip-item">
          <span className="strip-label">Sending</span>
          <span className={`badge ${sched.senderPaused ? 'err' : 'ok'}`}>{sched.senderPaused ? 'paused' : 'running'}</span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Send window</span>
          {sched.open ? (
            <>
              <span className="badge ok">open</span>
              <span>until {fmtTime(sched.closesAt, tz)}</span>
            </>
          ) : sched.nextOpening ? (
            <>
              <span className="badge pending">closed</span>
              <span>
                opens {fmtDayLabel(sched.nextOpening, tz)} {fmtTime(sched.nextOpening, tz)}{' '}
                <span className="muted">({relativeTime(sched.nextOpening)})</span>
              </span>
            </>
          ) : (
            <>
              <span className="badge err">closed</span>
              <span>no days enabled</span>
            </>
          )}
          <Link to="/settings" style={{ fontSize: 12 }}>
            edit
          </Link>
        </div>
        <div className="strip-item">
          <span className="strip-label">Reminders</span>
          <span className={`badge ${sched.remindersPaused ? 'err' : 'ok'}`}>{sched.remindersPaused ? 'paused' : 'active'}</span>
        </div>
        <div className="strip-item">
          <span className="strip-label">Pacing</span>
          <span>
            {sched.pacing?.minSec}–{sched.pacing?.maxSec} s between messages
          </span>
        </div>
      </div>

      <div className="tiles">
        <Tile
          label="Emails queued"
          value={counts.email || 0}
          hint={
            (counts.rows?.email || 0) > (counts.email || 0)
              ? `one per lot · ${counts.rows.email} buyers`
              : counts.email
                ? 'one per lot'
                : undefined
          }
          active={type === 'email'}
          onClick={() => setType(type === 'email' ? '' : 'email')}
        />
        <Tile
          label="Texts queued"
          value={counts.sms || 0}
          hint={
            (counts.rows?.sms || 0) > (counts.sms || 0)
              ? `one per lot · ${counts.rows.sms} phones`
              : counts.sms
                ? 'one per lot'
                : undefined
          }
          active={type === 'sms'}
          onClick={() => setType(type === 'sms' ? '' : 'sms')}
        />
        <Tile
          label="Calls queued"
          value={(calls.queuedCount || 0) + (calls.activeCount || 0)}
          hint={calls.active ? `calling Lot ${calls.active.lot?.lotNumber || ''} now` : undefined}
          onClick={() => document.getElementById('call-queue')?.scrollIntoView({ behavior: 'smooth' })}
        />
        <Tile
          label="Next send"
          value={data.nextSendAt ? fmtTime(data.nextSendAt, tz) : '—'}
          hint={data.nextSendAt ? `${fmtDayLabel(data.nextSendAt, tz)} · ${relativeTime(data.nextSendAt)}` : 'nothing queued'}
        />
        <Tile
          label="Sent today"
          value={(today.email || 0) + (today.sms || 0)}
          hint={`${today.email || 0} email · ${today.sms || 0} texts · ${today.calls || 0} calls${today.failed ? ` · ${today.failed} failed` : ''}`}
          accent={today.failed ? 'err' : undefined}
        />
      </div>

      {msg && (
        <div className={msg.startsWith('Error') ? 'error' : 'card'} style={{ marginBottom: 10 }}>
          {msg}
        </div>
      )}

      <h2 style={{ marginTop: 6 }}>Emails &amp; texts</h2>
      <div className="toolbar">
        <div className="chip-group">
          {[
            ['', 'All'],
            ['email', 'Emails'],
            ['sms', 'Texts'],
          ].map(([v, label]) => (
            <button key={v} type="button" className={`chip${type === v ? ' active' : ''}`} onClick={() => setType(v)}>
              {label}
            </button>
          ))}
        </div>
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        <input placeholder="Search recipient, lot, subject…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        {lotFilter && (
          <button type="button" className="chip active" onClick={() => setLotFilter('')} title="Show every lot">
            Lot {lotFiltered?.lotNumber || ''} only ✕
          </button>
        )}
        <div className="muted" style={{ fontSize: 12 }}>
          {items.length} shown · {selected.size} selected
          {data.truncated ? ' · showing the first 1000' : ''}
        </div>
        <div style={{ flex: 1 }} />
        <button className="danger" onClick={cancelSelected} disabled={busy || selected.size === 0}>
          Cancel {selected.size || ''} selected
        </button>
        <button className="secondary" onClick={cancelShown} disabled={busy || pendingShown.length === 0}>
          Cancel all shown
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="compact-table queue-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" ref={selectAllRef} checked={allSelected} onChange={toggleAll} title="Select every pending message shown" />
              </th>
              <th style={{ minWidth: 96 }}>Time</th>
              <th>Type</th>
              <th style={{ minWidth: 110 }}>Project</th>
              <th style={{ minWidth: 120 }}>Lot</th>
              <th style={{ minWidth: 170 }}>Buyers</th>
              <th style={{ minWidth: 220 }}>Message</th>
              <th style={{ minWidth: 110 }}>Kind</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="day-sep">
                  <td colSpan={9}>
                    {g.label}
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                      {plural(g.items.length, 'message')}
                    </span>
                  </td>
                </tr>
                {g.items.map((it) => (
                  <QueueRow
                    key={it.key}
                    it={it}
                    tz={tz}
                    selected={selected.has(it.key)}
                    onToggle={() => toggle(it.key)}
                    open={openId === it.key}
                    onOpen={() => openRow(it)}
                    detail={details[it.key]}
                    onSendNow={() => sendNow(it)}
                    onCancel={() => cancelOne(it)}
                    busy={busy}
                  />
                ))}
              </Fragment>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {counts.total === 0
                    ? 'Nothing is queued. Pick lots on the Board and click “Send” to queue the default email + text.'
                    : 'No queued messages match this filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 id="call-queue">Aria calls</h2>
      <div className="card">
        {calls.active ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="badge pending">calling now</span>
            <span>
              📞 <Link to={`/lots/${calls.active.lot?._id}`}>Lot {calls.active.lot?.lotNumber}</Link>
              {calls.active.buyer ? ` · ${calls.active.buyer.name || ''} ${calls.active.buyer.phone || ''}`.replace(/\s+/g, ' ') : ''}
              {calls.active.project?.name ? <span className="muted"> · {calls.active.project.name}</span> : null}
            </span>
            {calls.active.startedAt && <span className="muted" style={{ fontSize: 12 }}>started {relativeTime(calls.active.startedAt)}</span>}
          </div>
        ) : (
          <div className="muted" style={{ marginBottom: 8 }}>
            No call in progress.
          </div>
        )}
        {calls.pending && calls.pending.length > 0 ? (
          <>
            <table className="compact-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Lot</th>
                  <th>Project</th>
                  <th>Buyer</th>
                  <th>Queued</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {calls.pending.map((c, i) => (
                  <tr key={c._id}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      {c.lot?.deleted ? <span className="muted">(lot deleted)</span> : <Link to={`/lots/${c.lot._id}`}>Lot {c.lot.lotNumber}</Link>}
                      {c.lot?.address && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {c.lot.address}
                        </div>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {c.project?.name || ''}
                    </td>
                    <td>
                      {c.buyer ? (
                        <>
                          {c.buyer.name || <span className="muted">(no name)</span>}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {c.buyer.phone}
                          </div>
                        </>
                      ) : (
                        <span className="muted">no phone</span>
                      )}
                    </td>
                    <td className="muted nowrap" style={{ fontSize: 12 }}>
                      {fmtDateTime(c.createdAt, tz)}
                    </td>
                    <td className="nowrap">
                      <button className="danger small" onClick={() => cancelCall(c)} disabled={busy}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="secondary" onClick={clearCalls} disabled={busy}>
                Clear call queue
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Calls go one at a time; the next one starts when the previous ends.
              </span>
            </div>
          </>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            No calls waiting. On the <Link to="/board">Board</Link>, select lots and click <em>Call selected</em> to have Aria
            call them one by one.
          </div>
        )}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>How the queue works:</strong> the lot is the unit. Each row is one message for one lot:{' '}
        {data.emailPerLot ? 'one email addressed to every buyer on the lot' : 'the emails to that lot\'s buyers'}, or the texts
        to each of its phones, sent together. Messages leave in the order above, {sched.pacing?.minSec}–{sched.pacing?.maxSec}{' '}
        seconds apart, only inside the send window ({tz}). New batches line up after whatever is already queued.{' '}
        <em>Send now</em> skips the window and pacing for one message. <em>Cancel</em> removes it for good (the lot's reminder
        count is not reduced). Change the window, pacing or timezone in <Link to="/settings">Settings</Link> — the queue re-plans
        itself when you save.
      </div>
    </div>
  );
}

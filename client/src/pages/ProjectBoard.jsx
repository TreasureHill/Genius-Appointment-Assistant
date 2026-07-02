import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';
import MultiSelect from '../components/MultiSelect.jsx';

const BOARD_PAGE_SIZES = [25, 50, 100, 200];

const OUTREACH_SKIP_LABELS = {
  no_default_templates: 'no default email/SMS templates set (Settings or the project)',
  smtp_not_configured: 'SMTP not configured',
  twilio_not_configured: 'Twilio not configured',
  email_failed: 'email send failed',
  sms_failed: 'SMS send failed',
};
function outreachSkipNote(outreach) {
  const skipped = outreach?.skipped || [];
  if (!skipped.length) return '';
  return skipped.map((s) => OUTREACH_SKIP_LABELS[s] || s).join('; ');
}

const STATUSES = ['pending', 'contacted', 'scheduled', 'completed', 'opted_out'];
const ROLE_LABELS = { buyer: 'Buyer', coBuyer: 'Co-buyer', thirdBuyer: 'Third buyer' };

function BuyerCell({ buyer }) {
  if (!buyer || (!buyer.name && !buyer.email && !buyer.phone)) {
    return <span className="muted">—</span>;
  }
  // Concise: name on top, email + phone on one compact line.
  const contact = [buyer.email, buyer.phone].filter(Boolean).join(' · ');
  return (
    <div style={{ lineHeight: 1.3 }}>
      <div>
        <strong>{buyer.name || <span className="muted">(no name)</span>}</strong>
        {buyer.optedOut && (
          <span className="badge opted_out" style={{ marginLeft: 6 }}>
            opted out
          </span>
        )}
      </div>
      {contact && (
        <div
          className="muted"
          style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}
          title={contact}
        >
          {contact}
        </div>
      )}
    </div>
  );
}

const COMMS_ICON_PATHS = {
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  sms: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  call: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
  ),
  calendly: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </>
  ),
};
const COMMS_LABELS = { email: 'email', sms: 'SMS', call: 'call', calendly: 'Calendly match' };

function CommsIcons({ comms }) {
  const order = ['email', 'sms', 'call', 'calendly'];
  const present = order.filter((t) => (comms?.[t] || 0) > 0);
  if (!present.length) return <span className="muted">—</span>;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {present.map((t) => {
        const n = comms[t];
        return (
          <span
            key={t}
            title={`${n} ${COMMS_LABELS[t]}${n === 1 ? '' : 's'}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--muted)' }}
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {COMMS_ICON_PATHS[t]}
            </svg>
            {n > 1 && <span style={{ fontSize: 10 }}>{n}</span>}
          </span>
        );
      })}
    </div>
  );
}

function Tile({ label, value, active, onClick }) {
  return (
    <div
      className="tile"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        borderColor: active ? 'var(--primary)' : 'var(--border)',
        borderWidth: active ? 2 : 1,
      }}
    >
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
    </div>
  );
}

function parseIds(str) {
  if (!str) return [];
  return String(str).split(',').map((s) => s.trim()).filter(Boolean);
}

const ADD_ROLES = [
  { key: 'buyer', label: 'Buyer' },
  { key: 'coBuyer', label: 'Co-buyer' },
  { key: 'thirdBuyer', label: 'Third buyer' },
];

function AddLotModal({ projects, defaultProjectId, onClose, onCreated }) {
  const [form, setForm] = useState({
    project: defaultProjectId || projects[0]?._id || '',
    lotNumber: '',
    address: '',
    status: 'pending',
    notes: '',
  });
  const [buyers, setBuyers] = useState(
    ADD_ROLES.map(({ key }) => ({ role: key, name: '', email: '', phone: '', optedOut: false }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function setBuyer(i, patch) {
    setBuyers((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.project) return setErr('Pick a project.');
    if (!form.lotNumber.trim()) return setErr('Lot number is required.');
    setBusy(true);
    setErr('');
    try {
      const cleanBuyers = buyers.filter((b) => b.name || b.email || b.phone);
      const lot = await api.post('/api/lots', {
        project: form.project,
        lotNumber: form.lotNumber.trim(),
        address: form.address.trim(),
        status: form.status,
        notes: form.notes,
        buyers: cleanBuyers,
      });
      onCreated(lot);
    } catch (ex) {
      setErr(
        ex.status === 409
          ? 'A lot with that number already exists in this project.'
          : ex.message || 'Failed to create lot.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '5vh 16px',
        zIndex: 1000,
        overflowY: 'auto',
      }}
    >
      <form
        className="card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{ width: '100%', maxWidth: 640, margin: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Add lot</h2>
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="row">
          <div style={{ flex: 2 }}>
            <label>Project *</label>
            <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })}>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Lot # *</label>
            <input
              value={form.lotNumber}
              onChange={(e) => setForm({ ...form, lotNumber: e.target.value })}
              autoFocus
            />
          </div>
          <div>
            <label>Status</label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label>Address</label>
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />

        <h3 style={{ marginBottom: 4 }}>Buyers</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Add at least a phone number if you want to call this lot with Aria. Leave rows blank to skip.
        </div>
        {buyers.map((b, i) => (
          <div key={b.role} className="row" style={{ marginBottom: 8 }}>
            <div style={{ minWidth: 96, alignSelf: 'end', paddingBottom: 8 }}>{ADD_ROLES[i].label}</div>
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
          </div>
        ))}

        <label>Notes</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />

        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add lot'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ProjectBoard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialIds = parseIds(searchParams.get('project') || localStorage.getItem('board:project') || '');
  const [projects, setProjects] = useState([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => new Set(initialIds));
  const [maxReminders, setMaxReminders] = useState(null);
  const [lots, setLots] = useState([]);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [selected, setSelected] = useState(new Set());
  const [busyLotId, setBusyLotId] = useState(null);
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [queue, setQueue] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    api
      .get('/api/projects')
      .then((list) => {
        // Defend against a non-array payload (error envelope, proxy HTML, etc.):
        // projects.map runs during render, so a bad shape here would otherwise
        // throw and blank the page.
        const arr = Array.isArray(list) ? list : [];
        setProjects(arr);
        setLoadError('');
        // Reconcile any saved selection (URL / localStorage) against the projects
        // that actually exist. Without this, a deleted or stale project id leaves
        // the board querying a phantom project — empty table, nothing highlighted,
        // yet the header still claims "1/N selected".
        setSelectedProjectIds((prev) => {
          const valid = new Set(arr.map((p) => p._id));
          const pruned = new Set(Array.from(prev).filter((id) => valid.has(id)));
          if (pruned.size > 0) return pruned;
          // Nothing valid selected → default to the first project on a fresh visit.
          return arr.length ? new Set([arr[0]._id]) : new Set();
        });
      })
      .catch((e) => setLoadError('Could not load projects: ' + e.message));
    api
      .get('/api/settings')
      .then((s) => setMaxReminders(s?.schedule?.maxReminders ?? null))
      .catch(() => {});
  }, []);

  const selectedIdsKey = Array.from(selectedProjectIds).sort().join(',');

  useEffect(() => {
    if (!selectedIdsKey) {
      setLots([]);
      setSelected(new Set());
      localStorage.setItem('board:project', '');
      setSearchParams({}, { replace: true });
      return;
    }
    localStorage.setItem('board:project', selectedIdsKey);
    setSearchParams({ project: selectedIdsKey }, { replace: true });
    api
      .get(`/api/lots?projects=${selectedIdsKey}&limit=1000`)
      .then((l) => {
        setLots(Array.isArray(l) ? l : []);
        setSelected(new Set());
        setLoadError('');
      })
      .catch((e) => {
        setLots([]);
        setLoadError('Could not load lots: ' + e.message);
      });
  }, [selectedIdsKey]);

  function toggleProjectId(id) {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllProjects() {
    setSelectedProjectIds(new Set(projects.map((p) => p._id)));
  }
  function clearProjects() {
    setSelectedProjectIds(new Set());
  }

  const projectById = useMemo(() => new Map(projects.map((p) => [String(p._id), p])), [projects]);
  const showProjectCol = selectedProjectIds.size !== 1;
  const singleProject = selectedProjectIds.size === 1
    ? projectById.get(Array.from(selectedProjectIds)[0])
    : null;

  const byStatus = useMemo(() => {
    const m = { pending: 0, contacted: 0, scheduled: 0, completed: 0, opted_out: 0 };
    for (const l of lots) m[l.status] = (m[l.status] || 0) + 1;
    return m;
  }, [lots]);

  const filtered = useMemo(() => {
    return lots.filter((l) => {
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize]
  );

  // Reset to page 1 when the filter / project selection changes.
  useEffect(() => {
    setPage(1);
  }, [filter.status, filter.q, selectedIdsKey]);
  // Clamp page if the result set shrank.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const allSelected = filtered.length > 0 && filtered.every((l) => selected.has(l._id));
  const someSelected = filtered.some((l) => selected.has(l._id));

  // Drive the tri-state header checkbox: checked when every visible row is
  // selected, indeterminate when only some are. NOTE: this hook must live
  // ABOVE the early return below — React requires the same hooks to run on
  // every render, and the "no projects" early return would otherwise skip it.
  const selectAllRef = useRef(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allSelected && someSelected;
    }
  }, [allSelected, someSelected]);

  async function changeStatus(lot, status) {
    setBusyLotId(lot._id);
    try {
      await api.post(`/api/lots/${lot._id}/status`, { status });
      setLots((prev) => prev.map((l) => (l._id === lot._id ? { ...l, status } : l)));
    } finally {
      setBusyLotId(null);
    }
  }

  async function callLot(lot) {
    const hasPhone = (lot.buyers || []).some((b) => b.phone && !b.optedOut);
    if (!hasPhone) {
      setSendMsg(`Lot ${lot.lotNumber} has no buyer phone number to call.`);
      return;
    }
    setBusyLotId(lot._id);
    setSendMsg('');
    try {
      const r = await api.post(`/api/lots/${lot._id}/call`, {});
      setLots((prev) =>
        prev.map((l) => (l._id === lot._id ? { ...l, call: { ...(l.call || {}), status: 'calling' } } : l))
      );
      const ch = [];
      if (r.outreach?.used?.email) ch.push('email');
      if (r.outreach?.used?.sms) ch.push('SMS');
      const skipNote = ch.length ? '' : outreachSkipNote(r.outreach);
      setSendMsg(
        `Aria is calling ${r.to || 'the buyer'} for lot ${lot.lotNumber}.` +
          (ch.length ? ` Sent the project's ${ch.join(' + ')}.` : skipNote ? ` (No auto email/SMS — ${skipNote}.)` : '') +
          ' The transcript, recording, and any booking will appear on the lot page when the call ends.'
      );
    } catch (ex) {
      setSendMsg('Call failed: ' + ex.message);
    } finally {
      setBusyLotId(null);
    }
  }

  async function refreshQueue() {
    try {
      setQueue(await api.get('/api/calls/queue'));
    } catch {
      /* ignore */
    }
  }

  // Load any existing queue on mount.
  useEffect(() => {
    refreshQueue();
  }, []);

  // While the queue has anything active/pending, poll it (and refresh lots so
  // the per-row call badges track calling → completed) every 5s.
  const queueActive = !!queue && (queue.activeCount > 0 || queue.queuedCount > 0);
  useEffect(() => {
    if (!queueActive) return undefined;
    const t = setInterval(async () => {
      await refreshQueue();
      if (selectedIdsKey) {
        try {
          setLots(await api.get(`/api/lots?projects=${selectedIdsKey}&limit=1000`));
        } catch {
          /* ignore */
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [queueActive, selectedIdsKey]);

  async function queueSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setSendMsg('');
    try {
      const r = await api.post('/api/calls/queue', { lotIds: ids });
      setQueue(r.status);
      setSelected(new Set());
      const skips = (r.skipped || []).length;
      setSendMsg(
        `Queued ${r.queued.length} lot${r.queued.length === 1 ? '' : 's'} for Aria to call one by one` +
          (skips ? ` (skipped ${skips} — opted out / no phone / already queued)` : '') +
          '. They dial sequentially; each call starts when the previous one ends.'
      );
      // Reflect the "queued" badge immediately.
      const idSet = new Set(r.queued);
      setLots((prev) =>
        prev.map((l) => (idSet.has(String(l._id)) ? { ...l, call: { ...(l.call || {}), status: 'queued' } } : l))
      );
    } catch (ex) {
      setSendMsg('Could not queue calls: ' + ex.message);
    }
  }

  async function clearQueue() {
    try {
      const r = await api.del('/api/calls/queue');
      setQueue(r.status);
      setSendMsg(`Cleared ${r.cancelled} queued call${r.cancelled === 1 ? '' : 's'} (any in-progress call finishes).`);
      if (selectedIdsKey) setLots(await api.get(`/api/lots?projects=${selectedIdsKey}&limit=1000`));
    } catch (ex) {
      setSendMsg('Could not clear queue: ' + ex.message);
    }
  }

  async function deleteLot(lot) {
    if (!confirm(`Delete lot ${lot.lotNumber}? This removes the lot and any pending messages for it. Cannot be undone.`)) return;
    setBusyLotId(lot._id);
    try {
      await api.del(`/api/lots/${lot._id}`);
      setLots((prev) => prev.filter((l) => l._id !== lot._id));
      setSelected((prev) => {
        if (!prev.has(lot._id)) return prev;
        const next = new Set(prev);
        next.delete(lot._id);
        return next;
      });
    } catch (ex) {
      alert('Delete failed: ' + ex.message);
    } finally {
      setBusyLotId(null);
    }
  }

  async function deleteSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} lot${ids.length === 1 ? '' : 's'}? This also removes any pending messages for them. Cannot be undone.`)) return;
    try {
      const r = await api.post('/api/lots/bulk-delete', { ids });
      const idSet = new Set(ids);
      setLots((prev) => prev.filter((l) => !idSet.has(l._id)));
      setSelected(new Set());
      setSendMsg(`Deleted ${r.deleted} lot${r.deleted === 1 ? '' : 's'}.`);
    } catch (ex) {
      setSendMsg('Delete failed: ' + ex.message);
    }
  }

  function toggle(lotId) {
    const next = new Set(selected);
    if (next.has(lotId)) next.delete(lotId);
    else next.add(lotId);
    setSelected(next);
  }

  // Select-all operates on the *currently filtered* rows only, so it never
  // silently selects (or clears) lots hidden by the active status/search filter.
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allVisibleSelected = filtered.length > 0 && filtered.every((l) => next.has(l._id));
      if (allVisibleSelected) {
        for (const l of filtered) next.delete(l._id);
      } else {
        for (const l of filtered) next.add(l._id);
      }
      return next;
    });
  }

  async function sendDefaults({ all = false } = {}) {
    setSendMsg('');
    setSending(true);
    try {
      let body;
      if (all) {
        const pendingIds = lots.filter((l) => l.status === 'pending').map((l) => l._id);
        if (pendingIds.length === 0) {
          setSendMsg('Nothing pending in the selected projects.');
          setSending(false);
          return;
        }
        body = { lotIds: pendingIds };
      } else {
        if (selected.size === 0) {
          setSendMsg('Pick lots first, or click "Send to all pending".');
          setSending(false);
          return;
        }
        body = { lotIds: Array.from(selected) };
      }
      const result = await api.post('/api/messages/send-defaults', body);
      const tplBits = [];
      if (result.usedEmail) tplBits.push(`email "${result.usedEmail.name}"`);
      if (result.usedSms) tplBits.push(`SMS "${result.usedSms.name}"`);

      // Per-lot counts of how many messages were queued, for optimistic UI.
      const queuedByLot = new Map();
      for (const q of result.queued) {
        queuedByLot.set(q.lotId, (queuedByLot.get(q.lotId) || 0) + 1);
      }
      const touchedCount = queuedByLot.size;

      setLots((prev) =>
        prev.map((l) => {
          const add = queuedByLot.get(String(l._id)) || 0;
          if (!add) return l;
          return {
            ...l,
            reminderCount: (l.reminderCount || 0) + 1,
            pendingMessages: (l.pendingMessages || 0) + add,
          };
        })
      );

      setSendMsg(
        `Queued ${result.queued.length} message${result.queued.length === 1 ? '' : 's'} across ` +
          `${touchedCount} lot${touchedCount === 1 ? '' : 's'} ` +
          `(${tplBits.join(' + ') || 'no templates configured'}). ` +
          (result.skipped.length
            ? `Skipped ${result.skipped.length} (already contacted / scheduled / opted out / duplicate / missing contact). `
            : '') +
          'They go out spread over minutes per your pacing settings — the row counters will update as each message sends.'
      );
      setSelected(new Set());

      // Short polling burst so the board reflects sends as they happen
      // without the user having to refresh manually.
      const key = selectedIdsKey;
      const startedAt = Date.now();
      async function refresh() {
        if (!key || key !== selectedIdsKey) return;
        try {
          const fresh = await api.get(`/api/lots?projects=${key}&limit=1000`);
          setLots(fresh);
        } catch {}
        if (Date.now() - startedAt < 60_000) {
          setTimeout(refresh, 5_000);
        }
      }
      setTimeout(refresh, 1_500);
    } catch (ex) {
      setSendMsg('Error: ' + ex.message);
    } finally {
      setSending(false);
    }
  }

  if (projects.length === 0) {
    return (
      <div>
        <h1>Board</h1>
        <div className="muted">
          No projects yet. <Link to="/import">Import a sheet</Link> to create lots under a project.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Board</h1>
        {singleProject && (
          <Link to={`/projects/${singleProject._id}`} className="muted" style={{ fontSize: 13 }}>
            {singleProject.name} settings →
          </Link>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAdd(true)}>+ Add lot</button>
        <div className="muted" style={{ fontSize: 12 }}>
          Sending schedule lives in <Link to="/settings">Settings</Link>.
        </div>
      </div>

      {showAdd && (
        <AddLotModal
          projects={projects}
          defaultProjectId={Array.from(selectedProjectIds)[0] || projects[0]?._id}
          onClose={() => setShowAdd(false)}
          onCreated={(lot) => {
            setShowAdd(false);
            setSendMsg(`Added lot ${lot.lotNumber}.`);
            if (selectedProjectIds.has(String(lot.project))) {
              setLots((prev) => [lot, ...prev]);
            } else {
              // Surface the new lot by selecting its project (triggers a reload).
              setSelectedProjectIds((prev) => new Set([...prev, String(lot.project)]));
            }
          }}
        />
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Projects:</strong>
          <MultiSelect
            options={projects.map((p) => ({ value: p._id, label: p.name }))}
            value={Array.from(selectedProjectIds)}
            onChange={(vals) => setSelectedProjectIds(new Set(vals))}
            placeholder="Select projects…"
            allLabel="All projects"
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {selectedProjectIds.size} of {projects.length} selected
          </span>
        </div>
      </div>

      {loadError && (
        <div className="card alert alert-err" style={{ marginTop: 12 }}>
          {loadError}
        </div>
      )}

      <div className="tiles" style={{ marginTop: 16 }}>
        <Tile
          label="All lots"
          value={lots.length}
          active={!filter.status}
          onClick={() => setFilter({ ...filter, status: '' })}
        />
        {STATUSES.map((s) => (
          <Tile
            key={s}
            label={s.replace('_', ' ')}
            value={byStatus[s] || 0}
            active={filter.status === s}
            onClick={() => setFilter({ ...filter, status: filter.status === s ? '' : s })}
          />
        ))}
      </div>

      <div className="toolbar">
        <input
          placeholder="Search lot #, address, buyer name / email / phone…"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          style={{ flex: 1, minWidth: 240 }}
        />
        <div className="muted" style={{ fontSize: 12 }}>
          Showing {filtered.length} of {lots.length} · {selected.size} selected
        </div>
        <div style={{ flex: 1 }} />
        <button
          className="secondary"
          onClick={() => sendDefaults({ all: true })}
          disabled={sending || (byStatus.pending || 0) === 0}
          title="Sends the default email + SMS to every pending lot in this project. Already-contacted, scheduled, and opted-out lots are skipped."
        >
          Send to all pending ({byStatus.pending || 0})
        </button>
        <button onClick={() => sendDefaults({})} disabled={sending || selected.size === 0}>
          Send to {selected.size} selected
        </button>
        <button
          onClick={queueSelected}
          disabled={selected.size === 0}
          title="Call the selected lots one by one with Aria — each call starts when the previous ends"
        >
          📞 Call {selected.size} selected
        </button>
        <button
          className="danger"
          onClick={deleteSelected}
          disabled={selected.size === 0}
          title="Permanently delete the selected lots and any pending messages for them"
        >
          Delete {selected.size} selected
        </button>
      </div>

      {queue && (queue.activeCount > 0 || queue.queuedCount > 0) && (
        <div className="card" style={{ marginBottom: 10, borderColor: 'var(--primary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>📞 Aria call queue</strong>
            {queue.active ? (
              <span className="badge pending">
                calling Lot {queue.active.lot?.lotNumber || '—'}…
              </span>
            ) : (
              <span className="muted">starting…</span>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              {queue.queuedCount} waiting
            </span>
            <div style={{ flex: 1 }} />
            <button className="secondary" onClick={clearQueue} disabled={queue.queuedCount === 0}>
              Clear queue
            </button>
          </div>
          {queue.pending && queue.pending.length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Up next:{' '}
              {queue.pending.slice(0, 12).map((p) => p.lot?.lotNumber || '?').join(', ')}
              {queue.pending.length > 12 ? '…' : ''}
            </div>
          )}
        </div>
      )}
      {sendMsg && (
        <div className={sendMsg.startsWith('Error') ? 'error' : 'card'} style={{ marginBottom: 10 }}>
          {sendMsg}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="compact-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  ref={selectAllRef}
                  checked={allSelected}
                  onChange={toggleAll}
                  title="Select all matching lots"
                />
              </th>
              {showProjectCol && <th style={{ minWidth: 140 }}>Project</th>}
              <th style={{ minWidth: 70 }}>Lot #</th>
              <th style={{ minWidth: 140 }}>Address</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.buyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.coBuyer}</th>
              <th style={{ minWidth: 200 }}>{ROLE_LABELS.thirdBuyer}</th>
              <th style={{ minWidth: 140 }}>Status</th>
              <th style={{ minWidth: 100 }}>Reminders</th>
              <th style={{ minWidth: 84 }}>Comms</th>
              <th style={{ minWidth: 120 }}>Last contact</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((lot) => {
              const disabled = busyLotId === lot._id;
              return (
                <tr key={lot._id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(lot._id)}
                      onChange={() => toggle(lot._id)}
                    />
                  </td>
                  {showProjectCol && (
                    <td className="muted" style={{ fontSize: 12 }}>
                      {lot.project?.name || projectById.get(String(lot.project))?.name || ''}
                    </td>
                  )}
                  <td>
                    <Link to={`/lots/${lot._id}`}>
                      <strong>{lot.lotNumber}</strong>
                    </Link>
                  </td>
                  <td>{lot.address || <span className="muted">—</span>}</td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'buyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'coBuyer')} />
                  </td>
                  <td>
                    <BuyerCell buyer={(lot.buyers || []).find((b) => b.role === 'thirdBuyer')} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={lot.status} />
                        {lot.pendingMessages > 0 && (
                          <span
                            className="badge pending"
                            title="Messages queued for this lot — they'll send over the next few minutes per pacing"
                            style={{ fontSize: 10 }}
                          >
                            {lot.pendingMessages} queued
                          </span>
                        )}
                      </div>
                      <select
                        value={lot.status}
                        onChange={(e) => changeStatus(lot, e.target.value)}
                        disabled={disabled}
                        style={{ fontSize: 12 }}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s.replace('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td>
                    {lot.reminderCount}
                    {maxReminders != null ? ` / ${maxReminders}` : ''}
                  </td>
                  <td>
                    <CommsIcons comms={lot.comms} />
                  </td>
                  <td className="muted nowrap">
                    {lot.lastContactedAt
                      ? new Date(lot.lastContactedAt).toLocaleDateString()
                      : '—'}
                  </td>
                  <td className="nowrap">
                    <Link to={`/lots/${lot._id}`}>
                      <button className="secondary">Open</button>
                    </Link>{' '}
                    {(lot.buyers || []).some((b) => b.phone && !b.optedOut) && (
                      <>
                        <button
                          className="secondary"
                          onClick={() => callLot(lot)}
                          disabled={disabled || lot.call?.status === 'calling' || lot.call?.status === 'queued'}
                          title="Call this buyer with Aria (offers Calendly times & books on the call)"
                        >
                          {lot.call?.status === 'calling'
                            ? '📞 …'
                            : lot.call?.status === 'queued'
                              ? '📞 queued'
                              : '📞 Call'}
                        </button>{' '}
                      </>
                    )}
                    <button
                      className="danger"
                      onClick={() => deleteLot(lot)}
                      disabled={disabled}
                      title="Delete this lot"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={showProjectCol ? 12 : 11} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {selectedProjectIds.size === 0
                    ? 'Select a project above to see its lots.'
                    : lots.length === 0
                      ? 'This project has no lots yet. Import a sheet to add some.'
                      : 'No lots match your filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <div className="pagination">
          <div className="muted" style={{ fontSize: 12 }}>
            Showing {(page - 1) * pageSize + 1}–{Math.min(filtered.length, page * pageSize)} of{' '}
            {filtered.length}
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
            {BOARD_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button className="secondary" disabled={page <= 1} onClick={() => setPage(1)}>
            « First
          </button>
          <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Prev
          </button>
          <span className="muted" style={{ fontSize: 12, padding: '0 6px' }}>
            Page {page} of {totalPages}
          </span>
          <button className="secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Next ›
          </button>
          <button
            className="secondary"
            disabled={page >= totalPages}
            onClick={() => setPage(totalPages)}
          >
            Last »
          </button>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>How sending works:</strong> Select lots above, pick a template, click <em>Send</em>.
        Each selected lot's buyers are queued with the project's pacing jitter. Once sent, the lot
        flips to <span className="badge contacted">contacted</span> and automatic reminders begin
        after the configured interval — until the lot is marked{' '}
        <span className="badge scheduled">scheduled</span> (manually, by Calendly match, or manual
        mapping) or <span className="badge opted_out">opted out</span>, or the max reminder count
        is reached.
      </div>
    </div>
  );
}

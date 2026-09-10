import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import StatusBadge from '../components/StatusBadge.jsx';
import { useTimezone } from '../timezone.jsx';
import { fmtDateTime, fmtDayLabel, fmtTime, relativeTime, tzAbbrev } from '../time';

const ROLES = [
  { key: 'buyer', label: 'Buyer' },
  { key: 'coBuyer', label: 'Co-buyer' },
  { key: 'thirdBuyer', label: 'Third buyer' },
];
const STATUSES = ['pending', 'contacted', 'scheduled', 'completed', 'opted_out'];

const ACTOR_LABELS = {
  user: 'You',
  sender_worker: 'Sender',
  completion_worker: 'Auto-complete',
  calendly_sync: 'Calendly sync',
  calendly_map: 'Calendly mapping',
  aria_call: 'Aria (call)',
  system: 'System',
};

function emptyBuyer(role) {
  return { role, name: '', email: '', phone: '', optedOut: false };
}

function buildTimeline(history, events) {
  const items = [];
  for (const h of history || []) {
    let kind, icon, title, subtitle;
    if (h.type === 'email') {
      kind = 'email';
      icon = '✉';
      title = (h.direction === 'in' ? 'Email received' : 'Email sent') + (h.subject ? ` · ${h.subject}` : '');
      subtitle = `${h.direction === 'in' ? 'from' : 'to'} ${h.to || '—'}`;
    } else if (h.type === 'sms') {
      kind = 'sms';
      icon = '💬';
      title = h.direction === 'in' ? 'SMS received' : 'SMS sent';
      subtitle = `${h.direction === 'in' ? 'from' : 'to'} ${h.to || '—'}${h.body ? ' · ' + String(h.body).slice(0, 120) : ''}`;
    } else if (h.type === 'calendly') {
      kind = 'calendly';
      icon = '📅';
      title = h.subject || 'Calendly event';
      subtitle = h.body ? String(h.body).slice(0, 200) : '';
    } else if (h.type === 'call') {
      kind = 'call';
      icon = '📞';
      title = h.subject || (h.direction === 'in' ? 'Aria call result' : 'Aria call');
      subtitle = h.body ? String(h.body).slice(0, 200) : '';
    } else {
      kind = 'msg';
      icon = '•';
      title = h.subject || h.type;
      subtitle = h.body ? String(h.body).slice(0, 200) : '';
    }
    items.push({
      id: 'm-' + h._id,
      at: h.createdAt,
      kind,
      icon,
      title,
      subtitle,
      status: h.status,
      error: h.error,
      isReminder: h.isReminder,
      reminderIndex: h.reminderIndex,
    });
  }
  for (const e of events || []) {
    if (e.type !== 'status_change') continue;
    const actorLabel = ACTOR_LABELS[e.actor] || e.actor;
    items.push({
      id: 'e-' + e._id,
      at: e.createdAt,
      kind: 'status',
      icon: '🔄',
      title: `Status: ${(e.fromStatus || '—').replace('_', ' ')} → ${(e.toStatus || '—').replace('_', ' ')}`,
      subtitle: `${actorLabel}${e.message ? ' · ' + e.message : ''}`,
      toStatus: e.toStatus,
    });
  }
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return items;
}

const CALL_STATUS_META = {
  calling: { label: 'calling…', badge: 'pending' },
  completed: { label: 'completed', badge: 'ok' },
  voicemail: { label: 'voicemail', badge: 'contacted' },
  no_answer: { label: 'no answer', badge: 'err' },
  failed: { label: 'failed', badge: 'err' },
};

function fmtDuration(secs) {
  const s = Number(secs) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function CallWithAria({ lot, ariaCfg, calling, callMsg, onCall, tz }) {
  const callable = (lot.buyers || []).filter((b) => b.phone && !b.optedOut);
  const [role, setRole] = useState(callable[0]?.role || '');
  const call = lot.call || {};
  const inProgress = call.status === 'calling';
  const hasResult = call.status && call.status !== 'idle' && call.status !== 'calling';
  const meta = CALL_STATUS_META[call.status];
  const notConfigured = ariaCfg && ariaCfg.dispatchable === false;

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>📞 Call with Aria</h2>
        {meta && <span className={`badge ${meta.badge}`}>{meta.label}</span>}
        {call.booked && <span className="badge scheduled">booked on call</span>}
        <div style={{ flex: 1 }} />
        {callable.length > 1 && (
          <select value={role} onChange={(e) => setRole(e.target.value)} disabled={calling || inProgress}>
            {callable.map((b) => (
              <option key={b.role} value={b.role}>
                {ROLES.find((r) => r.key === b.role)?.label || b.role}: {b.name || b.phone}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => onCall(role)} disabled={calling || inProgress || callable.length === 0}>
          {inProgress ? 'Call in progress…' : calling ? 'Dialing…' : 'Call now'}
        </button>
      </div>

      <p className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
        Aria dials the buyer, offers open Calendly times, and can book the appointment right on the
        call. The transcript, recording, and outcome land here automatically when the call ends.
      </p>

      {callable.length === 0 && (
        <div className="error" style={{ fontSize: 13 }}>
          No buyer on this lot has a phone number — add one above to enable calling.
        </div>
      )}
      {notConfigured && (
        <div className="error" style={{ fontSize: 13 }}>
          Aria calling isn’t configured yet. Add your ElevenLabs keys in <Link to="/settings">Settings</Link>.
        </div>
      )}
      {callMsg && (
        <div className={callMsg.startsWith('Error') ? 'error' : 'success'} style={{ marginTop: 4 }}>
          {callMsg}
        </div>
      )}

      {inProgress && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Aria is on the phone with {call.toNumber || 'the buyer'}…
        </div>
      )}

      {hasResult && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="cal-grid" style={{ marginBottom: 8 }}>
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Outcome
              </div>
              <div>{call.outcome || call.status}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Duration
              </div>
              <div>{fmtDuration(call.durationSec)}</div>
            </div>
            {call.endedAt && (
              <div>
                <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Ended
                </div>
                <div>{fmtDateTime(call.endedAt, tz)}</div>
              </div>
            )}
          </div>

          {call.summary && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Summary
              </div>
              <div style={{ fontSize: 14 }}>{call.summary}</div>
            </div>
          )}

          {call.conversationId && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Recording
              </div>
              <audio
                controls
                preload="none"
                src={`/api/lots/${lot._id}/recording`}
                style={{ width: '100%', maxWidth: 420 }}
              >
                Your browser can’t play this recording.
              </audio>
            </div>
          )}

          {call.transcript && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>Transcript</summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 13,
                  maxHeight: 320,
                  overflow: 'auto',
                  background: 'var(--bg, #f8f8f8)',
                  padding: 10,
                  borderRadius: 6,
                  marginTop: 6,
                }}
              >
                {call.transcript}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function LotDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [calling, setCalling] = useState(false);
  const [callMsg, setCallMsg] = useState('');
  const [sendTpl, setSendTpl] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState('');
  const [queueMsg, setQueueMsg] = useState('');
  const { timezone: ctxTz } = useTimezone();
  const tz = cfg?.schedule?.timezone || ctxTz;

  async function load() {
    const [d, t] = await Promise.all([api.get(`/api/lots/${id}`), api.get('/api/templates')]);
    const buyers = ROLES.map(({ key }) => d.lot.buyers.find((b) => b.role === key) || emptyBuyer(key));
    setData({ ...d, lot: { ...d.lot, buyers } });
    setTemplates(t);
  }

  useEffect(() => {
    load();
    // Settings give us the Aria status (why the Call button is disabled) and
    // the send window / timezone (when a queued message will go out).
    api.get('/api/settings').then((s) => setCfg(s || null)).catch(() => {});
  }, [id]);

  // After dispatching a call, the transcript/summary/recording land later via
  // the ElevenLabs webhook — poll for ~3 minutes so they appear without a
  // manual refresh.
  async function pollForCallResult() {
    const startedAt = Date.now();
    async function tick() {
      try {
        const d = await api.get(`/api/lots/${id}`);
        const buyers = ROLES.map(({ key }) => d.lot.buyers.find((b) => b.role === key) || emptyBuyer(key));
        setData((prev) => ({ ...(prev || {}), ...d, lot: { ...d.lot, buyers } }));
        if (d.lot?.call?.status && d.lot.call.status !== 'calling') return; // done
      } catch {
        /* keep polling */
      }
      if (Date.now() - startedAt < 180_000) setTimeout(tick, 5_000);
    }
    setTimeout(tick, 4_000);
  }

  async function callWithAria(buyerRole) {
    setCalling(true);
    setCallMsg('');
    try {
      const r = await api.post(`/api/lots/${id}/call`, buyerRole ? { buyerRole } : {});
      const ch = [];
      if (r.outreach?.used?.email) ch.push('email');
      if (r.outreach?.used?.sms) ch.push('SMS');
      const skipLabels = {
        no_default_templates: 'no default email/SMS templates set',
        smtp_not_configured: 'SMTP not configured',
        twilio_not_configured: 'Twilio not configured',
        email_failed: 'email send failed',
        sms_failed: 'SMS send failed',
      };
      const skipNote = ch.length
        ? ''
        : (r.outreach?.skipped || []).map((s) => skipLabels[s] || s).join('; ');
      setCallMsg(
        `Calling ${r.to || 'the buyer'}…` +
          (ch.length ? ` Sent the project's ${ch.join(' + ')}.` : skipNote ? ` (No auto email/SMS — ${skipNote}.)` : '') +
          ' The transcript and recording will appear here when Aria finishes.'
      );
      if (r.lot) {
        const buyers = ROLES.map(({ key }) => (r.lot.buyers || []).find((b) => b.role === key) || emptyBuyer(key));
        setData((prev) => ({ ...(prev || {}), lot: { ...prev.lot, ...r.lot, buyers } }));
      }
      pollForCallResult();
    } catch (ex) {
      setCallMsg('Error: ' + ex.message);
    } finally {
      setCalling(false);
    }
  }

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

  async function queueSend() {
    if (!sendTpl) {
      setSendMsg('Pick a template first.');
      return;
    }
    setSendBusy(true);
    setSendMsg('');
    try {
      const result = await api.post(`/api/lots/${id}/send`, { templateId: sendTpl });
      const reasons = Array.from(new Set((result.skipped || []).map((s) => s.reason).filter(Boolean)));
      const zone = result.timezone || tz;
      if (result.queued.length === 0) {
        setSendMsg(`Warning: nothing was queued${reasons.length ? ` — ${reasons.join('; ')}` : ''}.`);
      } else {
        const n = result.queued.length;
        setSendMsg(
          `Queued ${n} message${n === 1 ? '' : 's'}. ` +
            (result.firstSendAt
              ? `Goes out ${fmtDayLabel(result.firstSendAt, zone)} ${fmtTime(result.firstSendAt, zone)} ${tzAbbrev(zone, result.firstSendAt)}` +
                (result.lastSendAt && result.lastSendAt !== result.firstSendAt
                  ? ` (last one ${fmtTime(result.lastSendAt, zone)})`
                  : '') +
                '.'
              : '') +
            (reasons.length ? ` Skipped: ${reasons.join('; ')}.` : '')
        );
      }
      load();
    } catch (ex) {
      setSendMsg('Error: ' + ex.message);
    } finally {
      setSendBusy(false);
    }
  }

  // Cancel / force one queued send (all of its rows: the email to every
  // buyer, or the texts to each phone).
  async function queueAction(q, action) {
    setQueueMsg('');
    try {
      await api.post(`/api/queue/${action}`, { ids: q.ids });
      const what = q.type === 'sms' ? 'text' : 'email';
      setQueueMsg(action === 'cancel' ? `Cancelled the ${what} to ${q.to}.` : `Sending the ${what} to ${q.to} now.`);
      load();
    } catch (ex) {
      setQueueMsg('Error: ' + ex.message);
    }
  }

  async function remove() {
    if (!confirm('Delete this lot? This cannot be undone.')) return;
    await api.del(`/api/lots/${id}`);
    window.location.href = `/projects/${data.lot.project._id}`;
  }

  async function clearBounce() {
    await api.post(`/api/lots/${id}/clear-bounce`);
    load();
  }

  const timeline = useMemo(
    () => (data ? buildTimeline(data.history || [], data.events || []) : []),
    [data]
  );

  // One row per send (lot × channel): the email to every buyer, or the texts
  // to each phone that go out together.
  const queuedSends = useMemo(() => {
    const out = [];
    const byKey = new Map();
    for (const q of data?.queued || []) {
      const key = q.sendGroup || String(q._id);
      const recipients =
        Array.isArray(q.recipients) && q.recipients.length
          ? q.recipients
          : [{ buyerIndex: q.buyerIndex, name: data?.lot?.buyers?.[q.buyerIndex]?.name || '', address: q.to }];
      let g = byKey.get(key);
      if (!g) {
        g = { ...q, key, ids: [String(q._id)], recipients: [...recipients], rows: 1 };
        byKey.set(key, g);
        out.push(g);
      } else {
        g.ids.push(String(q._id));
        g.recipients.push(...recipients);
        g.rows += 1;
        if (q.status === 'sending') g.status = 'sending';
        g.sendNow = g.sendNow && q.sendNow;
      }
      g.to = g.recipients.map((r) => r.address).filter(Boolean).join(', ');
    }
    return out;
  }, [data]);

  if (!data) return <div className="muted">Loading…</div>;
  const { lot, queued } = data;
  const calEvent = lot.calendlyEvent;
  const win = cfg?.schedule?.window;
  const windowNote = !win
    ? ''
    : win.open
      ? `The send window is open until ${fmtTime(win.closesAt, tz)} ${tzAbbrev(tz)}, so it goes out within minutes.`
      : win.nextOpening
        ? `The send window is closed right now — it will go out ${fmtDayLabel(win.nextOpening, tz)} at ${fmtTime(win.nextOpening, tz)} ${tzAbbrev(tz)}.`
        : 'No send days are enabled in Settings, so nothing will go out until one is.';
  const hasCalEvent = !!(calEvent && (calEvent.startTime || calEvent.name || calEvent.inviteeEmail));

  return (
    <div>
      <div className="page-head">
        <div>
          {lot.project?._id ? (
            <Link to={`/projects/${lot.project._id}`} className="muted" style={{ fontSize: 13 }}>
              ← {lot.project.name}
            </Link>
          ) : (
            <Link to="/projects" className="muted" style={{ fontSize: 13 }}>
              ← all projects
            </Link>
          )}
          <h1 style={{ margin: '4px 0 0' }}>
            Lot {lot.lotNumber}{' '}
            <span className={`badge ${lot.status}`} style={{ marginLeft: 8, verticalAlign: 'middle' }}>
              {lot.status.replace('_', ' ')}
            </span>
          </h1>
          {lot.address && (
            <div className="muted" style={{ fontSize: 13 }}>
              {lot.address}
            </div>
          )}
        </div>
      </div>

      {(lot.bounceCount || 0) > 0 && (
        <div className="card alert alert-err">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ fontSize: 20 }}>⚠️</div>
            <div style={{ flex: 1 }}>
              <strong>Recipient address rejected ({lot.bounceCount} time{lot.bounceCount === 1 ? '' : 's'}).</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Last error: {lot.lastBounceError || 'unknown'}
                {lot.lastBounceAt && <> · {fmtDateTime(lot.lastBounceAt, tz)}</>}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Likely a wrong email or phone — fix the buyer record and click "Clear" once the new
                address is correct.
              </div>
            </div>
            <button className="secondary" onClick={clearBounce}>
              Clear
            </button>
          </div>
        </div>
      )}

      {hasCalEvent && (
        <div className="card alert alert-ok">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ fontSize: 20 }}>📅</div>
            <div style={{ flex: 1 }}>
              <strong>{calEvent.name || 'Calendly event'}</strong>
              {calEvent.matchedBuyerRole && (
                <span className="badge ok" style={{ marginLeft: 8 }}>
                  matched on {calEvent.matchedBuyerRole === 'buyer' ? 'buyer' : calEvent.matchedBuyerRole === 'coBuyer' ? 'co-buyer' : 'third buyer'}
                </span>
              )}
              <div className="cal-grid">
                <div>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    When
                  </div>
                  <div>
                    {fmtDateTime(calEvent.startTime, tz)}
                    {calEvent.endTime && (
                      <span className="muted">
                        {' '}
                        – {fmtTime(calEvent.endTime, tz)}
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Invitee
                  </div>
                  <div>
                    <strong>{calEvent.inviteeName || '—'}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{calEvent.inviteeEmail}</div>
                  </div>
                </div>
                {calEvent.location && (
                  <div>
                    <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      Location
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>{calEvent.location}</div>
                  </div>
                )}
                <div>
                  <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Status
                  </div>
                  <div>{calEvent.inviteeStatus || 'active'}</div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {calEvent.rescheduleUrl && (
                  <a className="btn-link" href={calEvent.rescheduleUrl} target="_blank" rel="noreferrer">
                    Reschedule ↗
                  </a>
                )}
                {calEvent.cancelUrl && (
                  <a className="btn-link" href={calEvent.cancelUrl} target="_blank" rel="noreferrer">
                    Cancel ↗
                  </a>
                )}
                {lot.calendlyEventUri && (
                  <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>
                    {lot.calendlyEventUri}
                  </span>
                )}
              </div>
              {calEvent.lastSyncedAt && (
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Last synced {fmtDateTime(calEvent.lastSyncedAt, tz)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <CallWithAria
        lot={lot}
        ariaCfg={cfg?.aria || null}
        calling={calling}
        callMsg={callMsg}
        onCall={callWithAria}
        tz={tz}
      />

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
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Calendly is matched against every buyer email below — buyer, co-buyer, and third buyer.
        </div>
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
          <button className="secondary" onClick={() => quickStatus('scheduled')}>
            Mark scheduled (stops reminders)
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
        <h2 style={{ marginTop: 0 }}>Send a message</h2>
        <div className="muted" style={{ marginBottom: 6 }}>
          Queue a one-off email or text to this lot's buyers using any template. Reminders sent so far:{' '}
          {lot.reminderCount}
          {cfg?.schedule?.maxReminders != null ? ` of ${cfg.schedule.maxReminders}` : ''}.{' '}
          {windowNote}
        </div>
        <div className="row">
          <select value={sendTpl} onChange={(e) => setSendTpl(e.target.value)}>
            <option value="">Pick a template…</option>
            {templates.map((t) => (
              <option key={t._id} value={t._id}>
                [{t.type === 'sms' ? 'text' : 'email'}] {t.name}
              </option>
            ))}
          </select>
          <div style={{ alignSelf: 'end' }}>
            <button onClick={queueSend} disabled={sendBusy || !sendTpl}>
              {sendBusy ? 'Queueing…' : 'Queue send'}
            </button>
          </div>
        </div>
        {sendMsg && (
          <div className={sendMsg.startsWith('Error') || sendMsg.startsWith('Warning') ? 'error' : 'success'}>
            {sendMsg}
          </div>
        )}
      </div>

      {queuedSends.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            Waiting to go out ({queuedSends.length})
            <Link to={`/queue?lot=${lot._id}`} style={{ fontSize: 13, fontWeight: 400 }}>
              open in the queue →
            </Link>
          </h2>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Times in {tz} ({tzAbbrev(tz)}). <em>Send now</em> skips the send window; <em>Cancel</em>{' '}
            removes the message.
          </div>
          <table className="compact-table">
            <thead>
              <tr>
                <th>Goes out</th>
                <th>Type</th>
                <th>Buyers</th>
                <th>Message</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queuedSends.map((q) => (
                <tr key={q.key}>
                  <td className="nowrap">
                    <strong>
                      {fmtDayLabel(q.sendAfter, tz)} {fmtTime(q.sendAfter, tz)}
                    </strong>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {q.sendNow ? 'send now' : relativeTime(q.sendAfter)}
                    </div>
                  </td>
                  <td>
                    <span className={`badge type-${q.type}`}>{q.type === 'sms' ? 'SMS' : 'Email'}</span>
                  </td>
                  <td style={{ overflowWrap: 'anywhere' }}>
                    {q.recipients.map((r) => r.name).filter(Boolean).join(', ') || <span className="muted">—</span>}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {q.to}
                      {q.rows > 1 ? ` · ${q.rows} ${q.type === 'sms' ? 'texts' : 'emails'}, sent together` : ''}
                    </div>
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {q.renderedSubject || (q.type === 'sms' ? String(q.renderedBody || '').slice(0, 90) : '')}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {q.templateId?.name ? `template: ${q.templateId.name} · ` : ''}
                      {q.isReminder ? `reminder #${q.reminderIndex || 1}` : 'first send'}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={q.status} />
                  </td>
                  <td className="nowrap">
                    <button
                      className="secondary small"
                      disabled={q.status !== 'pending' || q.sendNow}
                      onClick={() => queueAction(q, 'send-now')}
                    >
                      Send now
                    </button>{' '}
                    <button className="danger small" disabled={q.status !== 'pending'} onClick={() => queueAction(q, 'cancel')}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {queueMsg && (
            <div className={queueMsg.startsWith('Error') ? 'error' : 'success'} style={{ marginTop: 6 }}>
              {queueMsg}
            </div>
          )}
        </div>
      )}

      <h2>Activity timeline</h2>
      <div className="card timeline-card">
        {timeline.length === 0 && (
          <div className="muted" style={{ textAlign: 'center', padding: 16 }}>
            No activity yet.
          </div>
        )}
        {timeline.map((item) => (
          <div key={item.id} className={`timeline-item timeline-${item.kind}`}>
            <div className="timeline-icon" aria-hidden>
              {item.icon}
            </div>
            <div className="timeline-body">
              <div className="timeline-title">
                {item.title}
                {item.kind === 'status' && item.toStatus && (
                  <span className={`badge ${item.toStatus}`} style={{ marginLeft: 8 }}>
                    {String(item.toStatus).replace('_', ' ')}
                  </span>
                )}
                {item.isReminder && (
                  <span className="badge contacted" style={{ marginLeft: 8 }}>
                    reminder #{item.reminderIndex || 1}
                  </span>
                )}
                {item.status && item.kind !== 'status' && (
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
              </div>
              {item.subtitle && <div className="timeline-sub muted">{item.subtitle}</div>}
              {item.error && <div className="error" style={{ fontSize: 11 }}>{item.error}</div>}
              <div className="timeline-when muted">{fmtDateTime(item.at, tz)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

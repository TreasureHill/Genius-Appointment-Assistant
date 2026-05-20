import { useEffect, useState } from 'react';
import { api } from '../api';

const DAY_DEFS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];
const DEFAULT_WINDOW = { enabled: true, start: '09:00', end: '21:00' };

function normalizeSendWindows(sw) {
  const out = {};
  for (const { key } of DAY_DEFS) {
    out[key] = {
      enabled: sw?.[key]?.enabled ?? DEFAULT_WINDOW.enabled,
      start: sw?.[key]?.start || DEFAULT_WINDOW.start,
      end: sw?.[key]?.end || DEFAULT_WINDOW.end,
    };
  }
  return out;
}

function nextSevenDays(sendWindows) {
  const SUN_TO_SAT = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const key = SUN_TO_SAT[d.getDay()];
    out.push({ date: d, key, window: sendWindows[key] || DEFAULT_WINDOW });
  }
  return out;
}

function ScheduleCard({ schedule, templates, onSaved }) {
  const [form, setForm] = useState({
    reminderIntervalDays: schedule.reminderIntervalDays ?? 14,
    maxReminders: schedule.maxReminders ?? 3,
    pacingMin: schedule.pacing?.minSec ?? 30,
    pacingMax: schedule.pacing?.maxSec ?? 120,
    defaultEmailTemplate: schedule.defaultEmailTemplate || '',
    defaultSmsTemplate: schedule.defaultSmsTemplate || '',
    sendWindows: normalizeSendWindows(schedule.sendWindows),
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  function setWindow(day, patch) {
    setForm((f) => ({
      ...f,
      sendWindows: { ...f.sendWindows, [day]: { ...f.sendWindows[day], ...patch } },
    }));
  }

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      await api.patch('/api/settings/schedule', {
        reminderIntervalDays: Number(form.reminderIntervalDays),
        maxReminders: Number(form.maxReminders),
        pacing: { minSec: Number(form.pacingMin), maxSec: Number(form.pacingMax) },
        sendWindows: form.sendWindows,
        defaultEmailTemplate: form.defaultEmailTemplate || null,
        defaultSmsTemplate: form.defaultSmsTemplate || null,
      });
      setMsg('Saved.');
      onSaved && onSaved();
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    } finally {
      setBusy(false);
    }
  }

  const preview = nextSevenDays(form.sendWindows);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Sending schedule</h2>
      <p className="muted">
        Applies system-wide. After a lot's first manual send, a reminder is queued every{' '}
        <strong>{form.reminderIntervalDays}</strong> day
        {form.reminderIntervalDays === 1 ? '' : 's'} until either max reminders is hit, the lot is
        marked <span className="badge scheduled">scheduled</span>, or the buyer opts out. Pacing
        adds a random gap between consecutive sends so a batch doesn't trip spam filters.
      </p>
      <div className="row">
        <div>
          <label>Reminder interval (days)</label>
          <input
            type="number"
            min="0"
            value={form.reminderIntervalDays}
            onChange={(e) => setForm({ ...form, reminderIntervalDays: e.target.value })}
          />
        </div>
        <div>
          <label>Max reminders per lot</label>
          <input
            type="number"
            min="0"
            value={form.maxReminders}
            onChange={(e) => setForm({ ...form, maxReminders: e.target.value })}
          />
        </div>
        <div>
          <label>Pacing min gap (seconds)</label>
          <input
            type="number"
            min="0"
            value={form.pacingMin}
            onChange={(e) => setForm({ ...form, pacingMin: e.target.value })}
          />
        </div>
        <div>
          <label>Pacing max gap (seconds)</label>
          <input
            type="number"
            min="0"
            value={form.pacingMax}
            onChange={(e) => setForm({ ...form, pacingMax: e.target.value })}
          />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Default email template</label>
          <select
            value={form.defaultEmailTemplate}
            onChange={(e) => setForm({ ...form, defaultEmailTemplate: e.target.value })}
          >
            <option value="">— pick one (used for sends + reminders) —</option>
            {templates.filter((t) => t.type === 'email').map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Default SMS template</label>
          <select
            value={form.defaultSmsTemplate}
            onChange={(e) => setForm({ ...form, defaultSmsTemplate: e.target.value })}
          >
            <option value="">— pick one (used for sends + reminders) —</option>
            {templates.filter((t) => t.type === 'sms').map((t) => (
              <option key={t._id} value={t._id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3 style={{ marginBottom: 4 }}>Send windows</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Reminders + queued sends only fire on enabled days, inside the window. Outside the window,
          messages defer to the next opening rather than dropping.
        </p>
        <div className="schedule-grid">
          {DAY_DEFS.map(({ key, label }) => {
            const w = form.sendWindows[key];
            return (
              <div key={key} className={`schedule-row${w.enabled ? '' : ' is-off'}`}>
                <label className="schedule-day">
                  <input
                    type="checkbox"
                    checked={w.enabled}
                    onChange={(e) => setWindow(key, { enabled: e.target.checked })}
                  />
                  <span>{label}</span>
                </label>
                <input
                  type="time"
                  value={w.start}
                  disabled={!w.enabled}
                  onChange={(e) => setWindow(key, { start: e.target.value })}
                />
                <span className="muted">to</span>
                <input
                  type="time"
                  value={w.end}
                  disabled={!w.enabled}
                  onChange={(e) => setWindow(key, { end: e.target.value })}
                />
                <span className="muted schedule-summary">
                  {w.enabled ? `${w.start}–${w.end}` : 'no sending'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 4 }}>Next 7 days</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Preview of when the sender worker will be allowed to dispatch.
        </p>
        <div className="schedule-preview">
          {preview.map((d) => (
            <div key={d.date.toISOString()} className={`schedule-preview-cell${d.window.enabled ? '' : ' is-off'}`}>
              <div className="schedule-preview-day">
                {d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
              <div className="schedule-preview-time">
                {d.window.enabled ? `${d.window.start}–${d.window.end}` : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save schedule'}
        </button>
        {msg && <span className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</span>}
      </div>
    </div>
  );
}

function OwnerCard({ owner, onSaved }) {
  const [form, setForm] = useState({
    name: owner.name || '',
    email: owner.email || '',
    phone: owner.phone || '',
    calendlyUri: owner.calendlyUri || '',
    calendlyUrl: owner.calendlyUrl || '',
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      await api.patch('/api/settings/owner', form);
      setMsg('Saved.');
      onSaved && onSaved();
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Owner</h2>
      <p className="muted">
        This system is for a single person. These details appear in email / SMS templates as{' '}
        <span className="kbd">{'{{owner.name}}'}</span>,{' '}
        <span className="kbd">{'{{owner.calendlyUrl}}'}</span>, etc., and the Calendly sync uses
        the user URI below.
      </p>
      <div className="row">
        <div>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label>Email</label>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label>Phone</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>Calendly user URI (for sync)</label>
          <input
            value={form.calendlyUri}
            onChange={(e) => setForm({ ...form, calendlyUri: e.target.value })}
            placeholder="https://api.calendly.com/users/…"
          />
        </div>
        <div style={{ flex: 2 }}>
          <label>Calendly scheduling URL (for templates)</label>
          <input
            value={form.calendlyUrl}
            onChange={(e) => setForm({ ...form, calendlyUrl: e.target.value })}
            placeholder="https://calendly.com/your-handle"
          />
        </div>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save owner info'}
        </button>
        {msg && <span className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</span>}
      </div>
    </div>
  );
}

function Health({ h }) {
  if (!h) return <span className="muted">—</span>;
  return (
    <>
      <span className={`badge ${h.ok ? 'ok' : 'err'}`}>{h.ok ? 'ok' : 'error'}</span>{' '}
      <span className="muted" style={{ fontSize: 12 }}>
        {h.message} {h.checkedAt ? `· ${new Date(h.checkedAt).toLocaleString()}` : ''}
      </span>
    </>
  );
}

function DangerZone({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function wipe() {
    if (!confirm(
      'WIPE THE DATABASE?\n\nThis permanently deletes every project, lot, message log, outbox row, import batch, and Calendly mapping. Settings, templates, and your login stay. This cannot be undone.\n\nProceed?'
    )) return;
    if (!confirm(
      'Are you ABSOLUTELY sure?\n\nThere is no undo. There is no backup. Click Cancel to back out.'
    )) return;
    if (!confirm(
      'Last chance. Click OK to wipe everything.'
    )) return;
    const typed = prompt('Type WIPE EVERYTHING (caps, with the space) to confirm.');
    if (typed !== 'WIPE EVERYTHING') {
      setMsg('Cancelled — confirmation text did not match.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post('/api/admin/wipe', { confirm: 'WIPE EVERYTHING' });
      const d = r.deleted || {};
      setMsg(
        `Database wiped. Removed ${d.projects} project${d.projects === 1 ? '' : 's'}, ` +
          `${d.lots} lot${d.lots === 1 ? '' : 's'}, ${d.messageLogs} message log${d.messageLogs === 1 ? '' : 's'}, ` +
          `${d.outbox} queued, ${d.importBatches} import batch${d.importBatches === 1 ? '' : 'es'}, ` +
          `${d.calendlyUnmatched} Calendly mapping${d.calendlyUnmatched === 1 ? '' : 's'}.`
      );
      onDone && onDone();
    } catch (ex) {
      setMsg('Wipe failed: ' + ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: '#fecaca' }}>
      <h2 style={{ marginTop: 0, color: '#b91c1c' }}>Danger zone</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Wipe all operational data — projects, lots, message history, queued sends, import batches,
        and Calendly mappings. Templates, settings, and your login are preserved. Cannot be undone.
        You'll be asked to confirm three times and then to type a phrase before anything is deleted.
      </p>
      <button className="danger" onClick={wipe} disabled={busy}>
        {busy ? 'Wiping…' : 'Wipe database'}
      </button>
      {msg && <div className={msg.startsWith('Wipe failed') || msg.startsWith('Cancelled') ? 'error' : 'success'} style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

export default function Settings() {
  const [s, setS] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testSmsTo, setTestSmsTo] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    const [a, b] = await Promise.all([api.get('/api/settings'), api.get('/api/templates')]);
    setS(a);
    setTemplates(b);
  }
  useEffect(() => {
    load();
  }, []);

  async function togglePause() {
    await api.post('/api/settings/pause', { paused: !s.senderPaused });
    load();
  }

  async function toggleRemindersPause() {
    await api.post('/api/settings/reminders/pause', { paused: !s.remindersPaused });
    load();
  }

  async function toggleEmailImportance() {
    await api.post('/api/settings/email-importance', { enabled: !s.emailHighImportance });
    load();
  }

  async function testSmtp() {
    setMsg('');
    try {
      const r = await api.post('/api/settings/test/smtp', { to: testEmailTo || undefined });
      setMsg((r.ok ? 'SMTP ok: ' : 'SMTP error: ') + r.message + (r.messageId ? ` (id ${r.messageId})` : ''));
    } catch (ex) {
      setMsg('SMTP error: ' + ex.message);
    } finally {
      load();
    }
  }
  async function testTwilio() {
    setMsg('');
    try {
      const r = await api.post('/api/settings/test/twilio', { to: testSmsTo || undefined });
      setMsg((r.ok ? 'Twilio ok: ' : 'Twilio error: ') + r.message + (r.messageId ? ` (id ${r.messageId})` : ''));
    } catch (ex) {
      setMsg('Twilio error: ' + ex.message);
    } finally {
      load();
    }
  }
  async function testCalendly() {
    setMsg('');
    try {
      const r = await api.post('/api/settings/test/calendly', {});
      setMsg((r.ok ? 'Calendly ok: ' : 'Calendly error: ') + r.message);
    } catch (ex) {
      setMsg('Calendly error: ' + ex.message);
    } finally {
      load();
    }
  }
  async function syncCalendly() {
    setMsg('Syncing Calendly…');
    try {
      const r = await api.post('/api/settings/calendly/sync', {});
      if (r.ok) {
        setMsg(
          `Calendly sync ok — ${r.reps} reps, ${r.emailsSeen} invitee emails, ${r.matched.length} lots matched`
        );
      } else {
        setMsg('Calendly sync: ' + (r.message || 'failed'));
      }
    } catch (ex) {
      setMsg('Calendly sync error: ' + ex.message);
    } finally {
      load();
    }
  }

  if (!s) return <div className="muted">Loading…</div>;

  return (
    <div>
      <h1>Settings & system health</h1>

      {msg && <div className="card">{msg}</div>}

      <OwnerCard owner={s.owner || {}} onSaved={load} />

      <ScheduleCard schedule={s.schedule || {}} templates={templates} onSaved={load} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sender</h2>
        <p className="muted">
          Pause to stop the worker from processing the outbox. New messages keep getting queued while
          paused, they just don't go out.
        </p>
        <button onClick={togglePause} className={s.senderPaused ? '' : 'secondary'}>
          {s.senderPaused ? 'Resume sending' : 'Pause sending'}
        </button>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            Master reminder switch — when on, the hourly scheduler stops queuing new reminders and
            any reminders already sitting in the outbox are skipped. Manual one-off sends from the
            Board still go through.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={toggleRemindersPause}
              className={s.remindersPaused ? '' : 'secondary'}
            >
              {s.remindersPaused ? 'Resume reminders' : 'Stop all reminders'}
            </button>
            <span className={`badge ${s.remindersPaused ? 'err' : 'ok'}`}>
              {s.remindersPaused ? 'paused' : 'active'}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>SMTP</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          Host: {s.smtp.host || '—'} · From: {s.smtp.from || '—'} ·{' '}
          {s.smtp.configured ? 'configured in .env' : 'not configured'}
        </div>
        <div>
          Last check: <Health h={s.smtp.health} />
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            High importance flag — when on, outgoing emails are tagged with{' '}
            <span className="kbd">Importance: High</span> /{' '}
            <span className="kbd">X-Priority: 1</span> so most clients show a red exclamation
            marker.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={toggleEmailImportance}
              className={s.emailHighImportance ? '' : 'secondary'}
            >
              {s.emailHighImportance ? 'Disable high importance' : 'Enable high importance'}
            </button>
            <span className={`badge ${s.emailHighImportance ? 'ok' : ''}`}>
              {s.emailHighImportance ? 'on' : 'off'}
            </span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div>
            <label>Send test email to</label>
            <input
              value={testEmailTo}
              onChange={(e) => setTestEmailTo(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button onClick={testSmtp}>{testEmailTo ? 'Send test' : 'Verify connection'}</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Twilio</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          From: {s.twilio.from || '—'} ·{' '}
          {s.twilio.configured ? 'configured in .env' : 'not configured'}
        </div>
        <div>
          Last check: <Health h={s.twilio.health} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div>
            <label>Send test SMS to</label>
            <input
              value={testSmsTo}
              onChange={(e) => setTestSmsTo(e.target.value)}
              placeholder="+15555550123"
            />
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button onClick={testTwilio}>{testSmsTo ? 'Send test' : 'Verify connection'}</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Calendly</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          {s.calendly.configured ? 'Token set in .env' : 'Token not configured'} · Last sync:{' '}
          {s.calendly.lastSync ? new Date(s.calendly.lastSync).toLocaleString() : '—'} ·{' '}
          {s.calendly.health?.message || ''}
        </div>
        <div
          className="muted"
          style={{ fontSize: 12, marginBottom: 8, border: '1px dashed var(--border)', padding: 8, borderRadius: 6 }}
        >
          <strong>Note:</strong> Sync pulls <em>Scheduled Events</em> (actual bookings someone has
          made on your Calendly link), not <em>Event Types</em> (the meeting-link templates). If
          you only created a new Event Type, nothing will appear here until someone books a time
          through it. Time window scanned: 30 days ago → 1 year ahead.
        </div>
        <div>
          Last check: <Health h={s.calendly.health} />
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button onClick={testCalendly} className="secondary">
            Verify connection
          </button>
          <button onClick={syncCalendly}>Sync now</button>
        </div>
      </div>

      <DangerZone onDone={load} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Defaults (.env)</h2>
        <ul className="muted" style={{ marginTop: 0 }}>
          <li>Pacing: {s.defaults.pacingMin}–{s.defaults.pacingMax} seconds between sends</li>
          <li>Reminder interval: {s.defaults.reminderDays} days</li>
          <li>Max reminders per lot: {s.defaults.maxReminders}</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Per-project default template overrides live on each project's detail page — when set,
          they take priority over the system-wide defaults above.
        </p>
      </div>
    </div>
  );
}

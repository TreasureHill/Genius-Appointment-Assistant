import { useEffect, useState } from 'react';
import { api } from '../api';

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

export default function Settings() {
  const [s, setS] = useState(null);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testSmsTo, setTestSmsTo] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    setS(await api.get('/api/settings'));
  }
  useEffect(() => {
    load();
  }, []);

  async function togglePause() {
    await api.post('/api/settings/pause', { paused: !s.senderPaused });
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

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sender</h2>
        <p className="muted">
          Pause to stop the worker from processing the outbox. New messages keep getting queued while
          paused, they just don't go out.
        </p>
        <button onClick={togglePause} className={s.senderPaused ? '' : 'secondary'}>
          {s.senderPaused ? 'Resume sending' : 'Pause sending'}
        </button>
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
          {s.calendly.lastSync ? new Date(s.calendly.lastSync).toLocaleString() : '—'}
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

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Defaults (.env)</h2>
        <ul className="muted" style={{ marginTop: 0 }}>
          <li>Pacing: {s.defaults.pacingMin}–{s.defaults.pacingMax} seconds between sends</li>
          <li>Reminder interval: {s.defaults.reminderDays} days</li>
          <li>Max reminders per lot: {s.defaults.maxReminders}</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Per-project overrides live on each project's settings panel.
        </p>
      </div>
    </div>
  );
}

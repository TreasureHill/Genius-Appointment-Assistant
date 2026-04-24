import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

function Tile({ label, value }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
    </div>
  );
}

function Health({ name, h }) {
  if (!h) return null;
  const cls = h.ok ? 'badge ok' : 'badge err';
  return (
    <div style={{ marginRight: 12 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {name}
      </div>
      <span className={cls}>{h.ok ? 'connected' : 'disconnected'}</span>
      {h.message && (
        <div className="muted" style={{ fontSize: 11, marginTop: 2, maxWidth: 240 }}>
          {h.message}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/api/dashboard').then(setD).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="error">{err}</div>;
  if (!d) return <div className="muted">Loading…</div>;

  const m24 = d.messages.last24h;
  const m7 = d.messages.last7d;

  return (
    <div>
      <h1>Dashboard</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Provider status</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          <Health name="SMTP" h={d.health.smtp} />
          <Health name="Twilio" h={d.health.twilio} />
          <Health name="Calendly" h={d.health.calendly} />
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              Sender
            </div>
            <span className={`badge ${d.health.senderPaused ? 'err' : 'ok'}`}>
              {d.health.senderPaused ? 'paused' : 'running'}
            </span>
          </div>
        </div>
      </div>

      <h2>Lots by status</h2>
      <div className="tiles">
        {['pending', 'contacted', 'scheduled', 'booked', 'opted_out'].map((s) => (
          <Tile key={s} label={s.replace('_', ' ')} value={d.lotsByStatus[s] || 0} />
        ))}
      </div>

      <h2>Messages — last 24h / 7d</h2>
      <div className="tiles">
        <Tile label="Emails sent (24h)" value={m24.email.out} />
        <Tile label="SMS sent (24h)" value={m24.sms.out} />
        <Tile label="Inbound SMS (24h)" value={m24.sms.in} />
        <Tile label="Calendly matches (24h)" value={m24.calendly.in} />
        <Tile label="Emails sent (7d)" value={m7.email.out} />
        <Tile label="SMS sent (7d)" value={m7.sms.out} />
        <Tile label="Queued" value={d.outboxByStatus.pending || 0} />
        <Tile label="Failed (7d)" value={m7.email.out + m7.sms.out > 0 ? d.outboxByStatus.failed || 0 : 0} />
      </div>

      {d.unmatchedCalendly && d.unmatchedCalendly.count > 0 && (
        <>
          <h2>
            Unmatched Calendly events ({d.unmatchedCalendly.count}){' '}
            <Link to="/calendly" style={{ fontSize: 13 }}>
              manage →
            </Link>
          </h2>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Event time</th>
                  <th>Rep</th>
                  <th>Invitee</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {d.unmatchedCalendly.recent.map((e) => (
                  <tr key={e._id}>
                    <td className="nowrap">
                      {e.eventStartTime ? new Date(e.eventStartTime).toLocaleString() : '—'}
                    </td>
                    <td>{e.repName || e.rep?.name || ''}</td>
                    <td>
                      <div>
                        <strong>{e.inviteeName || '—'}</strong>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {e.inviteeEmail}
                      </div>
                    </td>
                    <td>{e.eventName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {d.warnings && d.warnings.length > 0 && (
        <>
          <h2>Warnings</h2>
          <div className="card">
            {d.warnings.map((w) => (
              <div key={w._id} style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
                <Link to={`/lots/${w._id}`}>
                  Lot {w.lotNumber} ({w.project?.name})
                </Link>{' '}
                — <span className="muted">{w.calendlyWarning}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Per project</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Total</th>
              <th>Pending</th>
              <th>Contacted</th>
              <th>Scheduled</th>
              <th>Booked</th>
              <th>Opted out</th>
              <th>Reminder cfg</th>
            </tr>
          </thead>
          <tbody>
            {d.perProject.map((p) => (
              <tr key={p._id}>
                <td>
                  <Link to={`/projects/${p._id}`}>{p.name}</Link>
                </td>
                <td>{p.totalLots}</td>
                <td>{p.byStatus.pending}</td>
                <td>{p.byStatus.contacted}</td>
                <td>{p.byStatus.scheduled}</td>
                <td>{p.byStatus.booked}</td>
                <td>{p.byStatus.opted_out}</td>
                <td className="muted nowrap">
                  every {p.reminderIntervalDays}d · max {p.maxReminders}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Recent activity</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Dir</th>
              <th>Project</th>
              <th>Lot</th>
              <th>To</th>
              <th>Status</th>
              <th>Subject / body</th>
            </tr>
          </thead>
          <tbody>
            {d.recent.map((r) => (
              <tr key={r._id}>
                <td className="nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.type}</td>
                <td>{r.direction}</td>
                <td>{r.project?.name || ''}</td>
                <td>{r.lot?.lotNumber || ''}</td>
                <td>{r.to}</td>
                <td>
                  <span className={`badge ${r.status === 'sent' || r.status === 'received' ? 'ok' : r.status === 'failed' ? 'err' : 'pending'}`}>
                    {r.status}
                  </span>
                </td>
                <td>{r.subject || r.body?.slice(0, 80)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

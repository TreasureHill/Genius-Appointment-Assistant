import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { browserTimezone, calendarDays, fmtClock, fmtDateTime, isValidTimezone, timezoneOptions, tzAbbrev } from '../time';
import { RECOMMENDED_FIRST_MESSAGE, RECOMMENDED_SYSTEM_PROMPT } from '../ariaDefaults';

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

// The next 7 calendar days *in the schedule timezone* (not the browser's),
// each paired with that weekday's window.
function nextSevenDays(sendWindows, tz, now) {
  return calendarDays(tz, 7, now).map((d) => ({ ...d, window: sendWindows[d.weekdayKey] || DEFAULT_WINDOW }));
}

function ScheduleCard({ schedule, templates, onSaved }) {
  const { refresh: refreshTimezone } = useTimezone();
  const [form, setForm] = useState({
    timezone: schedule.timezone || browserTimezone(),
    reminderIntervalDays: schedule.reminderIntervalDays ?? 14,
    maxReminders: schedule.maxReminders ?? 3,
    pacingMin: schedule.pacing?.minSec ?? 30,
    pacingMax: schedule.pacing?.maxSec ?? 120,
    defaultEmailTemplate: schedule.defaultEmailTemplate || '',
    defaultSmsTemplate: schedule.defaultSmsTemplate || '',
    emailPerLot: schedule.emailPerLot !== false,
    sendWindows: normalizeSendWindows(schedule.sendWindows),
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // A slow clock so "right now it is …" stays honest while the page is open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const tzValid = isValidTimezone(form.timezone);
  const tz = tzValid ? form.timezone : browserTimezone();
  const browserTz = browserTimezone();
  const tzOptions = useMemo(() => timezoneOptions(), []);
  const preview = useMemo(() => nextSevenDays(form.sendWindows, tz, now), [form.sendWindows, tz, now]);
  const inherited = schedule.timezoneSource && schedule.timezoneSource !== 'schedule';

  function setWindow(day, patch) {
    setForm((f) => ({
      ...f,
      sendWindows: { ...f.sendWindows, [day]: { ...f.sendWindows[day], ...patch } },
    }));
  }

  async function save() {
    if (!tzValid) {
      setMsg('Error: pick a valid timezone first (for example America/Toronto).');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.patch('/api/settings/schedule', {
        timezone: form.timezone,
        reminderIntervalDays: Number(form.reminderIntervalDays),
        maxReminders: Number(form.maxReminders),
        pacing: { minSec: Number(form.pacingMin), maxSec: Number(form.pacingMax) },
        sendWindows: form.sendWindows,
        defaultEmailTemplate: form.defaultEmailTemplate || null,
        defaultSmsTemplate: form.defaultSmsTemplate || null,
        emailPerLot: !!form.emailPerLot,
      });
      const rp = r?.replan || {};
      let text = 'Saved.';
      if (rp.total) {
        const n = `${rp.total} queued message${rp.total === 1 ? '' : 's'}`;
        text += rp.moved
          ? ` Re-planned ${n} to match — the first goes out ${fmtDateTime(rp.firstSendAt, form.timezone)} ${tzAbbrev(form.timezone, rp.firstSendAt)}.`
          : ` The ${n} already matched this schedule.`;
      }
      setMsg(text);
      refreshTimezone();
      onSaved && onSaved();
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Sending schedule</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Applies to every project. Queued emails and texts only go out on enabled days, inside the
        window, in the timezone below, spaced by the pacing gap so a batch doesn't trip spam filters.
        After a lot's first send, a reminder is queued every <strong>{form.reminderIntervalDays}</strong>{' '}
        day{Number(form.reminderIntervalDays) === 1 ? '' : 's'} until max reminders is hit, the lot is
        marked <span className="badge scheduled">scheduled</span>, or the buyer opts out.
      </p>

      <div className="tz-box">
        <div className="row">
          <div style={{ flex: 2 }}>
            <label style={{ marginTop: 0 }}>Timezone — send windows and every queued time use this zone</label>
            <input
              list="tz-options"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value.trim() })}
              placeholder="America/Toronto"
              style={{ borderColor: tzValid ? undefined : 'var(--danger)' }}
              spellCheck={false}
            />
            <datalist id="tz-options">
              {tzOptions.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          {form.timezone !== browserTz && (
            <div style={{ alignSelf: 'end', flex: 1 }}>
              <button type="button" className="secondary" onClick={() => setForm({ ...form, timezone: browserTz })}>
                Use my browser's zone ({browserTz})
              </button>
            </div>
          )}
        </div>
        <div style={{ fontSize: 12.5, marginTop: 6 }}>
          {tzValid ? (
            <>
              Right now it is <strong>{fmtDateTime(now, tz)} {tzAbbrev(tz, now)}</strong> in {tz}.
              {inherited && form.timezone === schedule.timezone ? (
                <span className="muted"> This zone is inherited — save once to pin it.</span>
              ) : null}
              {form.timezone !== browserTz ? (
                <span className="muted"> Your browser is in {browserTz}; the app still shows times in {tz}.</span>
              ) : null}
            </>
          ) : (
            <span className="error" style={{ margin: 0 }}>
              “{form.timezone}” is not a valid timezone. Start typing a city, e.g. Toronto.
            </span>
          )}
        </div>
      </div>

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

      <div style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 4 }}>One message per lot</h3>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 4, color: 'var(--text)', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!form.emailPerLot}
            onChange={(e) => setForm({ ...form, emailPerLot: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Send one email per lot</strong>, addressed to every buyer on it (the greeting reads{' '}
            <span className="kbd">Hi Jane and John,</span>). Off: a separate personalised email per buyer.
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Texts always go one per phone. Either way a lot counts as <strong>one</strong> send per channel
              on the Queue, the Board and the Dashboard, takes one pacing slot, and uses one reminder.
            </div>
          </span>
        </label>
      </div>

      <div style={{ marginTop: 18 }}>
        <h3 style={{ marginBottom: 4 }}>Send windows ({tz})</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Queued messages and reminders only go out on enabled days, inside the window. Anything queued
          outside it waits for the next opening instead of being dropped.
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
                  {w.enabled ? `${fmtClock(w.start)} – ${fmtClock(w.end)}` : 'no sending'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 4 }}>Next 7 days</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          When messages are allowed to go out, day by day, in {tz}.
        </p>
        <div className="schedule-preview">
          {preview.map((d) => (
            <div key={d.key} className={`schedule-preview-cell${d.window.enabled ? '' : ' is-off'}`}>
              <div className="schedule-preview-day">{d.isToday ? 'Today' : d.label}</div>
              <div className="schedule-preview-time">
                {d.window.enabled ? (
                  <>
                    {fmtClock(d.window.start)}
                    <br />
                    – {fmtClock(d.window.end)}
                  </>
                ) : (
                  '—'
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy || !tzValid}>
          {busy ? 'Saving…' : 'Save schedule'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Saving re-plans everything already in the <Link to="/queue">Queue</Link> to match.
        </span>
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

function StatusDot({ ok, label }) {
  return (
    <span style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
      <span className={`badge ${ok ? 'ok' : 'err'}`}>{ok ? '✓' : '✗'}</span>{' '}
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
    </span>
  );
}

function AriaCard({ aria, onSaved }) {
  const [form, setForm] = useState({
    calendlyEventTypeUri: aria.calendlyEventTypeUri || '',
    timezone: aria.timezone || 'America/New_York',
    calendlyLocationKind: aria.calendlyLocationKind || '',
    calendlyLocationDetail: aria.calendlyLocationDetail || '',
    firstMessage: aria.firstMessage || '',
    systemPrompt: aria.systemPrompt || '',
  });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [eventTypes, setEventTypes] = useState(null);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [perm, setPerm] = useState(null); // agent Security-tab override toggles
  const [permBusy, setPermBusy] = useState(false);
  const [callPreview, setCallPreview] = useState(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const placeholders = aria.placeholders || ['first_name', 'lot_number', 'project_name', 'available_slots'];

  // Ask ElevenLabs which overrides the agent honours — the usual reason a
  // first message "isn't said" is that the Security toggle is off.
  async function loadPermissions() {
    if (!aria.apiKeySet || !aria.agentIdSet) return;
    setPermBusy(true);
    try {
      setPerm(await api.get('/api/settings/aria/overrides'));
    } catch (ex) {
      setPerm({ ok: false, message: ex.message });
    } finally {
      setPermBusy(false);
    }
  }
  useEffect(() => {
    loadPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aria.apiKeySet, aria.agentIdSet]);

  async function enableOverrides() {
    if (!confirm('Turn on the "First message" and "System prompt" override toggles on your ElevenLabs agent (Security tab)? Nothing else on the agent changes.')) return;
    setPermBusy(true);
    setMsg('');
    try {
      const r = await api.post('/api/settings/aria/overrides/enable', {});
      setPerm(r);
      setMsg(r.firstMessage && r.prompt ? 'Overrides enabled on the agent — your first message and prompt will be used on the next call.' : 'ElevenLabs answered, but the toggles still read off. Enable them in the agent’s Security tab.');
    } catch (ex) {
      setMsg('Error enabling overrides: ' + ex.message);
    } finally {
      setPermBusy(false);
    }
  }

  async function previewCall() {
    setMsg('');
    setCallPreview({ loading: true });
    try {
      const r = await api.post('/api/settings/aria/preview', {
        firstMessage: form.firstMessage,
        systemPrompt: form.systemPrompt,
      });
      setCallPreview(r);
    } catch (ex) {
      setCallPreview({ error: ex.message });
    }
  }

  const needsFirst = !!(form.firstMessage && form.firstMessage.trim());
  const needsPrompt = !!(form.systemPrompt && form.systemPrompt.trim());

  // Fill a field with the recommended text (saved only when the owner clicks
  // Save Aria settings).
  function useRecommended(field) {
    const current = form[field] || '';
    const next = field === 'firstMessage' ? RECOMMENDED_FIRST_MESSAGE : RECOMMENDED_SYSTEM_PROMPT;
    if (current.trim() === next.trim()) return;
    if (current.trim() && !confirm('Replace the current text with the recommended version? You can still edit it before saving.')) return;
    setForm((f) => ({ ...f, [field]: next }));
    setCallPreview(null);
  }
  const overridesBlocked = perm && perm.ok && ((needsFirst && !perm.firstMessage) || (needsPrompt && !perm.prompt));

  async function loadEventTypes() {
    setLoadingTypes(true);
    setMsg('');
    try {
      const r = await api.get('/api/settings/aria/event-types');
      if (r.ok) {
        setEventTypes(r.eventTypes || []);
        if (!r.eventTypes?.length) setMsg('No event types found on your Calendly account.');
      } else {
        setMsg('Calendly: ' + (r.message || 'could not load event types'));
        setEventTypes([]);
      }
    } catch (ex) {
      setMsg('Error loading event types: ' + ex.message);
    } finally {
      setLoadingTypes(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      await api.patch('/api/settings/aria', form);
      setMsg('Saved.');
      onSaved && onSaved();
    } catch (ex) {
      setMsg('Error: ' + ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function previewAvailability() {
    setMsg('');
    setPreview({ loading: true });
    try {
      const r = await api.post('/api/settings/aria/availability-preview', { limit: 6 });
      setPreview(r);
    } catch (ex) {
      setPreview({ available: false, message: ex.message, slots: [] });
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>📞 Aria voice calling (ElevenLabs)</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Aria calls homeowners, offers open Calendly times, and books the appointment on the call.
        Secrets (API key, agent id, phone-number id) live in <span className="kbd">.env</span>; the
        Calendly event type and prompts are set here.
      </p>

      <div style={{ marginBottom: 12 }}>
        <StatusDot ok={aria.apiKeySet} label="API key" />
        <StatusDot ok={aria.agentIdSet} label="Agent id" />
        <StatusDot ok={aria.agentPhoneSet} label="Agent phone id" />
        <StatusDot ok={aria.dispatchable} label="Ready to call" />
        <StatusDot ok={aria.webhookSecretSet} label="Webhook secret" />
        <StatusDot ok={aria.toolSecretSet} label="Tool secret" />
      </div>

      <div className="row">
        <div style={{ flex: 3 }}>
          <label>Calendly event type URI (what Aria books)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={form.calendlyEventTypeUri}
              onChange={(e) => setForm({ ...form, calendlyEventTypeUri: e.target.value })}
              placeholder="https://api.calendly.com/event_types/…"
            />
            <button type="button" className="secondary" onClick={loadEventTypes} disabled={loadingTypes}>
              {loadingTypes ? 'Loading…' : 'Load my event types'}
            </button>
          </div>
          {eventTypes && eventTypes.length > 0 && (
            <select
              style={{ marginTop: 6 }}
              value={form.calendlyEventTypeUri}
              onChange={(e) => {
                const et = eventTypes.find((x) => x.uri === e.target.value);
                setForm((f) => ({
                  ...f,
                  calendlyEventTypeUri: e.target.value,
                  // Auto-fill the location from the picked event type when Calendly exposes it.
                  ...(et?.locationKind ? { calendlyLocationKind: et.locationKind } : {}),
                  ...(et?.locationDetail ? { calendlyLocationDetail: et.locationDetail } : {}),
                }));
              }}
            >
              <option value="">— pick an event type —</option>
              {eventTypes.map((et) => (
                <option key={et.uri} value={et.uri}>
                  {et.name}
                  {et.duration ? ` (${et.duration} min)` : ''}
                  {et.active ? '' : ' — inactive'}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label>Timezone (for spoken times)</label>
          <input
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            placeholder="America/New_York"
          />
        </div>
      </div>

      <label>Calendly location kind (usually auto-detected — set only if booking fails)</label>
      <input
        value={form.calendlyLocationKind}
        onChange={(e) => setForm({ ...form, calendlyLocationKind: e.target.value })}
        placeholder="leave blank to auto-detect from the event type"
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>
        Aria books directly on Calendly and normally detects this from your event type. Only set it
        if booking fails with a location error. Map: <span className="kbd">In-person → physical</span>,{' '}
        <span className="kbd">Phone call → outbound_call</span>,{' '}
        <span className="kbd">Zoom → zoom_conference</span>,{' '}
        <span className="kbd">Google Meet → google_conference</span>. (Casing/labels are normalized.)
      </div>

      <label>Location detail (address / phone / note — required for in-person, phone & custom)</label>
      <input
        value={form.calendlyLocationDetail}
        onChange={(e) => setForm({ ...form, calendlyLocationDetail: e.target.value })}
        placeholder="e.g. 1621 Major Mackenzie Dr E, Richmond Hill, ON"
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>
        Calendly requires the location text when the kind is <span className="kbd">physical</span>,{' '}
        <span className="kbd">custom</span>, or <span className="kbd">ask_invitee</span>. For an
        in-person event, put the address here (auto-used from the event type when Calendly exposes it).
      </div>

      {(needsFirst || needsPrompt) && perm && (
        <div
          className={`card alert ${overridesBlocked ? 'alert-err' : perm.ok ? 'alert-ok' : 'alert-warn'}`}
          style={{ marginTop: 12, marginBottom: 12, padding: '10px 14px' }}
        >
          {perm.ok ? (
            <>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <strong>Agent “{perm.agentName || perm.agentId}” — overrides allowed:</strong>
                <span>
                  <span className={`badge ${perm.firstMessage ? 'ok' : 'err'}`}>{perm.firstMessage ? '✓' : '✗'}</span>{' '}
                  <span className="muted" style={{ fontSize: 12 }}>First message</span>
                </span>
                <span>
                  <span className={`badge ${perm.prompt ? 'ok' : 'err'}`}>{perm.prompt ? '✓' : '✗'}</span>{' '}
                  <span className="muted" style={{ fontSize: 12 }}>System prompt</span>
                </span>
                <button type="button" className="secondary" onClick={loadPermissions} disabled={permBusy} style={{ fontSize: 12, padding: '4px 10px' }}>
                  {permBusy ? 'Checking…' : 'Re-check'}
                </button>
                {overridesBlocked && (
                  <button type="button" onClick={enableOverrides} disabled={permBusy} style={{ fontSize: 12, padding: '4px 10px' }}>
                    Enable on the agent
                  </button>
                )}
              </div>
              {overridesBlocked ? (
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  <strong>This is why Aria doesn’t say your first sentence.</strong> ElevenLabs disables overrides by default,
                  so the {needsFirst && !perm.firstMessage ? 'first message' : ''}
                  {needsFirst && !perm.firstMessage && needsPrompt && !perm.prompt ? ' and ' : ''}
                  {needsPrompt && !perm.prompt ? 'system prompt' : ''} set here {needsFirst && !perm.firstMessage && needsPrompt && !perm.prompt ? 'are' : 'is'}{' '}
                  refused or ignored and the agent uses its dashboard default
                  {perm.agentFirstMessage ? <> (“{perm.agentFirstMessage.slice(0, 120)}{perm.agentFirstMessage.length > 120 ? '…' : ''}”)</> : null}.
                  Click <em>Enable on the agent</em>, or open the agent in ElevenLabs → Security → Enable overrides → First
                  message + System prompt.
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  ElevenLabs will use the first message and prompt below on every call.
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12.5 }}>
              Couldn’t read the agent’s Security settings: {perm.message || perm.reason || 'unknown error'}.{' '}
              <button type="button" className="secondary" onClick={loadPermissions} disabled={permBusy} style={{ fontSize: 12, padding: '4px 10px' }}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>First message (optional) — what Aria says the moment the call connects</span>
        <button type="button" className="secondary small" onClick={() => useRecommended('firstMessage')} style={{ marginLeft: 'auto' }}>
          Use recommended
        </button>
      </label>
      <textarea
        value={form.firstMessage}
        onChange={(e) => setForm({ ...form, firstMessage: e.target.value })}
        placeholder="Hi {{first_name}}, this is Aria calling about Lot {{lot_number}} at {{project_name}}…"
        rows={2}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>
        Placeholders (write them as <span className="kbd">{'{{first_name}}'}</span> or <span className="kbd">{'{first_name}'}</span>, both work):{' '}
        {placeholders.map((n, i) => (
          <span key={n}>
            {i > 0 ? ', ' : ''}
            <span className="kbd">{`{{${n}}}`}</span>
          </span>
        ))}
        . They are filled in on this server before the call, so the agent never has to declare them.
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>System prompt override (optional)</span>
        <button type="button" className="secondary small" onClick={() => useRecommended('systemPrompt')} style={{ marginLeft: 'auto' }}>
          Use recommended
        </button>
      </label>
      <textarea
        value={form.systemPrompt}
        onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        placeholder="Leave blank to use the prompt configured on the ElevenLabs agent."
        rows={form.systemPrompt && form.systemPrompt.length > 400 ? 14 : 3}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 2, marginBottom: 6 }}>
        The recommended prompt is written for a phone call: short turns, no filler sounds, times in words, an honest
        after-booking line (Calendly emails the calendar invite; no confirmation text is sent), and clear handling of
        voicemail, wrong person, "not now", and opt-outs. Click <em>Preview what Aria will say</em> to see it rendered
        for a real lot.
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save Aria settings'}
        </button>
        <button className="secondary" onClick={previewAvailability}>
          Preview availability
        </button>
        <button className="secondary" onClick={previewCall} title="Render the first message and prompt for a real lot, without calling">
          Preview what Aria will say
        </button>
        {msg && <span className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</span>}
      </div>

      {callPreview && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {callPreview.loading ? (
            <span className="muted">Rendering…</span>
          ) : callPreview.error ? (
            <div className="error">{callPreview.error}</div>
          ) : (
            <div className="card" style={{ margin: 0, background: 'var(--panel-subtle)' }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Rendered for {callPreview.sample ? 'a sample lot (add a lot with a phone to preview real data)' : <>Lot {callPreview.lot?.lotNumber} · {callPreview.lot?.project}{callPreview.buyer?.name ? ` · ${callPreview.buyer.name}` : ''}</>}.
                This is exactly what the next call would send, using the text in the boxes above (saved or not).
              </div>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>Aria opens with</div>
              {callPreview.firstMessage ? (
                <div style={{ fontSize: 14, margin: '2px 0 8px' }}>“{callPreview.firstMessage}”</div>
              ) : (
                <div className="muted" style={{ margin: '2px 0 8px' }}>
                  No first message set here — the agent’s dashboard first message is used.
                </div>
              )}
              {callPreview.unresolved?.firstMessage?.length > 0 && (
                <div className="error" style={{ margin: '0 0 8px' }}>
                  These placeholders have no value and would be spoken literally:{' '}
                  {callPreview.unresolved.firstMessage.map((n) => `{{${n}}}`).join(', ')}
                </div>
              )}
              {callPreview.prompt ? (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>System prompt as sent ({callPreview.prompt.length} characters)</summary>
                  <pre className="message-pre" style={{ marginTop: 6 }}>{callPreview.prompt}</pre>
                </details>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>No system prompt override — the agent’s dashboard prompt is used.</div>
              )}
              {callPreview.unresolved?.prompt?.length > 0 && (
                <div className="error" style={{ margin: '6px 0 0' }}>
                  Unfilled placeholders in the prompt: {callPreview.unresolved.prompt.map((n) => `{{${n}}}`).join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {preview.loading ? (
            <span className="muted">Checking Calendly…</span>
          ) : preview.available ? (
            <div>
              <div className="muted" style={{ marginBottom: 4 }}>Next open slots:</div>
              <ul style={{ margin: 0 }}>
                {preview.slots.map((s) => (
                  <li key={s.start_time}>{s.label}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="error">{preview.message}</div>
          )}
        </div>
      )}

      <div
        className="muted"
        style={{ fontSize: 12, marginTop: 12, border: '1px dashed var(--border)', padding: 8, borderRadius: 6 }}
      >
        <strong>Configure these URLs on the ElevenLabs agent:</strong>
        <div>Post-call webhook: <span className="kbd">{origin}/api/webhooks/elevenlabs</span></div>
        <div>Tool — get availability: <span className="kbd">{origin}/api/aria/tools/availability</span></div>
        <div>Tool — book appointment: <span className="kbd">{origin}/api/aria/tools/book</span></div>
        <div style={{ marginTop: 4 }}>
          Send the <span className="kbd">x-aria-secret</span> header (= ARIA_TOOL_SECRET) on both
          tools, and set the same webhook secret (= ELEVENLABS_WEBHOOK_SECRET) on the agent.
        </div>
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
          `Calendly sync ok — ${r.events} event${r.events === 1 ? '' : 's'}, ` +
            `${r.emailsSeen} invitee email${r.emailsSeen === 1 ? '' : 's'}, ` +
            `${r.matched.length} lot${r.matched.length === 1 ? '' : 's'} matched` +
            `${r.unmatched ? `, ${r.unmatched} unmatched` : ''}`
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
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Settings</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            The sending schedule and timezone come first — they decide when queued emails and texts go
            out. Provider connections, Calendly and Aria are below.
          </div>
        </div>
        <Link to="/queue" className="btn-link">
          Open the queue →
        </Link>
      </div>

      {msg && <div className="card">{msg}</div>}

      <ScheduleCard schedule={s.schedule || {}} templates={templates} onSaved={load} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Sending controls</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Pause sending to hold every queued email and text — they stay in the{' '}
          <Link to="/queue">Queue</Link> and go out when you resume. You can keep queueing while paused.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={togglePause} className={s.senderPaused ? '' : 'secondary'}>
            {s.senderPaused ? 'Resume sending' : 'Pause sending'}
          </button>
          <span className={`badge ${s.senderPaused ? 'err' : 'ok'}`}>{s.senderPaused ? 'paused' : 'running'}</span>
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            Master reminder switch — when paused, the hourly scheduler stops queuing new reminders and
            reminders already in the queue are held. Manual sends from the Board still go through. To
            pause reminders for a single project instead, use the toggle on that project's page.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={toggleRemindersPause}
              className={s.remindersPaused ? '' : 'secondary'}
            >
              {s.remindersPaused ? 'Resume reminders' : 'Pause all reminders'}
            </button>
            <span className={`badge ${s.remindersPaused ? 'err' : 'ok'}`}>
              {s.remindersPaused ? 'paused' : 'active'}
            </span>
          </div>
        </div>
      </div>

      <OwnerCard owner={s.owner || {}} onSaved={load} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Email (SMTP)</h2>
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
        <h2 style={{ marginTop: 0 }}>SMS (Twilio)</h2>
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

      <AriaCard aria={s.aria || {}} onSaved={load} />

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

      <DangerZone onDone={load} />
    </div>
  );
}

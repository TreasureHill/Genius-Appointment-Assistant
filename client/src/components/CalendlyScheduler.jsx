import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { timezoneOptions } from '../time';
import { Avatar, escapeHtml, fullTime } from '../mailUtil.jsx';
import Modal from './ui/Modal.jsx';
import Icon from './ui/Icon.jsx';

const DAY_MS = 864e5;

function dayKey(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}
function fmt(d, tz, opts) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(d));
  }
}
const timeLabel = (d, tz) => fmt(d, tz, { hour: 'numeric', minute: '2-digit' });

// Seven calendar days (in `tz`) starting from the day containing `start`.
function weekDays(start, tz) {
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < 7 && i < 9; i += 1) {
    const at = start + i * DAY_MS;
    const key = dayKey(at, tz);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, at });
  }
  return out;
}

// "Schedule with <name>": pick an event type, browse a week of real open
// Calendly times, then book it (Calendly sends the invite) or drop a link to
// that exact time into the reply.
export default function CalendlyScheduler({ open, onClose, person, threadId, defaultTz, onInsert, onBooked }) {
  const [name, setName] = useState(person?.name || '');
  const [email, setEmail] = useState(person?.email || '');
  const [types, setTypes] = useState(null);
  const [typesError, setTypesError] = useState('');
  const [typeUri, setTypeUri] = useState('');
  const [tz, setTz] = useState(defaultTz || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekStart, setWeekStart] = useState(() => Date.now());
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [picked, setPicked] = useState(null);
  const [answers, setAnswers] = useState({});
  const [phone, setPhone] = useState('');
  const [existing, setExisting] = useState([]);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState(null);
  const [booked, setBooked] = useState(null);
  const [jumping, setJumping] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(person?.name || '');
    setEmail(person?.email || '');
    setPicked(null);
    setBooked(null);
    setBookError(null);
    setWeekStart(Date.now());
  }, [open, person?.email, person?.name]);

  useEffect(() => {
    if (!open || types) return;
    api
      .get('/api/calendly/event-types')
      .then((r) => {
        if (!r.ok) {
          setTypesError(r.message || 'Calendly is not connected.');
          setTypes([]);
          return;
        }
        setTypes(r.eventTypes);
        const def = r.eventTypes.find((t) => t.uri === r.defaultEventTypeUri) || r.eventTypes[0];
        if (def) setTypeUri(def.uri);
        if (!defaultTz && r.timezone) setTz(r.timezone);
      })
      .catch((e) => {
        setTypesError(e.message);
        setTypes([]);
      });
  }, [open, types, defaultTz]);

  useEffect(() => {
    if (!open || !email) return;
    api
      .get(`/api/calendly/invitee-events?email=${encodeURIComponent(email)}`)
      .then((r) => setExisting((r.events || []).filter((e) => e.status === 'active')))
      .catch(() => setExisting([]));
  }, [open, email]);

  const days = useMemo(() => weekDays(weekStart, tz), [weekStart, tz]);

  useEffect(() => {
    if (!open || !typeUri) return undefined;
    let cancelled = false;
    setLoadingSlots(true);
    setSlotsError('');
    const start = new Date(weekStart).toISOString();
    const end = new Date(weekStart + 7 * DAY_MS).toISOString();
    api
      .get(`/api/calendly/slots?eventType=${encodeURIComponent(typeUri)}&start=${start}&end=${end}&tz=${encodeURIComponent(tz)}`)
      .then((r) => !cancelled && setSlots(r.slots || []))
      .catch((e) => !cancelled && (setSlots([]), setSlotsError(e.message)))
      .finally(() => !cancelled && setLoadingSlots(false));
    return () => {
      cancelled = true;
    };
  }, [open, typeUri, weekStart, tz]);

  const byDay = useMemo(() => {
    const m = new Map(days.map((d) => [d.key, []]));
    for (const s of slots) {
      const k = dayKey(s.startTime, tz);
      if (m.has(k)) m.get(k).push(s);
    }
    return m;
  }, [slots, days, tz]);

  const type = types?.find((t) => t.uri === typeUri) || null;
  const requiredQs = (type?.questions || []).filter((q) => q.required);
  const needsPhone = type?.locationKind === 'outbound_call';
  const isThisWeek = weekStart <= Date.now() + 60_000;

  async function jumpToNext() {
    setJumping(true);
    try {
      const r = await api.get(`/api/calendly/next-available?eventType=${encodeURIComponent(typeUri)}&from=${new Date(weekStart).toISOString()}&tz=${encodeURIComponent(tz)}`);
      if (r.slot) {
        setWeekStart(Math.max(Date.now(), new Date(r.slot.startTime).getTime() - 60 * 60 * 1000));
        setPicked(r.slot);
      } else setSlotsError('No open times in the next 60 days.');
    } catch (e) {
      setSlotsError(e.message);
    } finally {
      setJumping(false);
    }
  }

  async function book() {
    setBooking(true);
    setBookError(null);
    try {
      const r = await api.post('/api/calendly/book', {
        eventTypeUri: typeUri,
        startTime: picked.startTime,
        name,
        email,
        timezone: tz,
        threadId,
        phone,
        answers: requiredQs.map((q) => ({ question: q.name, answer: answers[q.name] || '' })),
      });
      setBooked({ ...r, slot: picked, type });
      onBooked?.(r);
    } catch (e) {
      setBookError({ message: e.message });
    } finally {
      setBooking(false);
    }
  }

  function insertSlotLink() {
    if (!picked) return;
    const when = `${fmt(picked.startTime, tz, { weekday: 'long', month: 'long', day: 'numeric' })} at ${timeLabel(picked.startTime, tz)}`;
    const url = picked.schedulingUrl || type?.schedulingUrl;
    onInsert?.(`<p>You can confirm ${escapeHtml(when)} here: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`);
    onClose();
  }

  function insertBookingPage() {
    if (!type?.schedulingUrl) return;
    onInsert?.(`<p>Pick any time that suits you here: <a href="${escapeHtml(type.schedulingUrl)}">${escapeHtml(type.schedulingUrl)}</a></p>`);
    onClose();
  }

  function insertConfirmation() {
    const when = `${fmt(booked.slot.startTime, tz, { weekday: 'long', month: 'long', day: 'numeric' })} at ${timeLabel(booked.slot.startTime, tz)}`;
    let html = `<p>You're all set for ${escapeHtml(when)} (${escapeHtml(tzShort(tz, booked.slot.startTime))}). A calendar invitation is on its way from Calendly.</p>`;
    if (booked.rescheduleUrl) html += `<p>If you need to change it: <a href="${escapeHtml(booked.rescheduleUrl)}">reschedule</a>.</p>`;
    onInsert?.(html);
    onClose();
  }

  const tzList = useMemo(() => {
    const list = timezoneOptions();
    return list.includes(tz) ? list : [tz, ...list];
  }, [tz]);

  const notConnected = types && !types.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={980}
      className="sched-modal"
      icon={<Icon name="calendarPlus" size={18} />}
      title={booked ? 'Booked on Calendly' : `Schedule with ${name || email || 'contact'}`}
      subtitle={booked ? null : 'Pick a real open time from your Calendly — book it now, or send them a link to that exact time.'}
    >
      {notConnected ? (
        <div className="sched-empty">
          <Icon name="calendar" size={28} />
          <div className="sched-empty-title">{/not connected/i.test(typesError) ? 'Calendly isn’t connected yet' : 'No event types found'}</div>
          <div className="muted">{typesError || 'Create an event type in Calendly first.'}</div>
          <Link to="/integrations" className="btn-link" onClick={onClose} style={{ marginTop: 12 }}>
            <Icon name="plug" size={14} /> Open Integrations
          </Link>
        </div>
      ) : booked ? (
        <div className="sched-done">
          <div className="sched-done-check">
            <Icon name="check" size={30} strokeWidth={2.4} />
          </div>
          <div className="sched-done-title">{booked.type?.name || 'Meeting'} with {name || email}</div>
          <div className="sched-done-when">{fullTime(booked.slot.startTime, tz)}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            Calendly has sent the invitation to {email}. The lot (if any) updates on the next Calendly sync.
          </div>
          <div className="sched-done-actions">
            {onInsert && (
              <button type="button" onClick={insertConfirmation}>
                <Icon name="reply" size={15} /> Add confirmation to my reply
              </button>
            )}
            <button type="button" className="secondary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="sched">
          <aside className="sched-side">
            <div className="sched-person">
              <Avatar person={{ name, email }} size={40} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <input className="sched-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Invitee name" />
                <input className="sched-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" aria-label="Invitee email" />
              </div>
            </div>

            {existing.length > 0 && (
              <div className="sched-existing">
                <div className="sched-label">
                  <Icon name="info" size={13} /> Already on the calendar
                </div>
                {existing.slice(0, 3).map((e) => (
                  <div key={e.uri} className={`sched-existing-row${e.upcoming ? '' : ' is-past'}`}>
                    <strong>{e.name}</strong>
                    <span>{fullTime(e.startTime, tz)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="sched-label">Event type</div>
            <div className="sched-types">
              {types === null && <div className="skeleton" style={{ height: 52 }} />}
              {(types || []).map((t) => (
                <button
                  type="button"
                  key={t.uri}
                  className={`sched-type${t.uri === typeUri ? ' is-active' : ''}`}
                  onClick={() => {
                    setTypeUri(t.uri);
                    setPicked(null);
                  }}
                >
                  <i style={{ background: t.color || '#4f46e5' }} />
                  <span className="sched-type-name">{t.name}</span>
                  <span className="sched-type-meta">
                    {t.duration ? `${t.duration} min` : ''}
                    {t.locationKind ? ` · ${locationLabel(t.locationKind)}` : ''}
                  </span>
                </button>
              ))}
            </div>

            <div className="sched-label">Time zone</div>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className="sched-tz">
              {tzList.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </select>

            {type?.schedulingUrl && onInsert && (
              <button type="button" className="link-btn sched-page-link" onClick={insertBookingPage}>
                <Icon name="link" size={13} /> Insert my booking page instead
              </button>
            )}
          </aside>

          <section className="sched-main">
            <div className="sched-nav">
              <button type="button" className="icon-btn" disabled={isThisWeek} onClick={() => setWeekStart((w) => Math.max(Date.now(), w - 7 * DAY_MS))} aria-label="Previous week">
                <Icon name="chevronLeft" size={18} />
              </button>
              <div className="sched-range">
                {fmt(days[0].at, tz, { month: 'short', day: 'numeric' })} – {fmt(days[days.length - 1].at, tz, { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
              <button type="button" className="icon-btn" onClick={() => setWeekStart((w) => w + 7 * DAY_MS)} aria-label="Next week">
                <Icon name="chevronRight" size={18} />
              </button>
              <div style={{ flex: 1 }} />
              {!isThisWeek && (
                <button type="button" className="chip" onClick={() => setWeekStart(Date.now())}>
                  This week
                </button>
              )}
              <button type="button" className="chip" onClick={jumpToNext} disabled={!typeUri || jumping}>
                {jumping ? 'Looking…' : 'Next available'}
              </button>
            </div>

            <div className={`sched-grid${loadingSlots ? ' is-loading' : ''}`}>
              {days.map((d) => {
                const list = byDay.get(d.key) || [];
                const isToday = d.key === dayKey(Date.now(), tz);
                return (
                  <div className="sched-day" key={d.key}>
                    <div className={`sched-day-head${isToday ? ' is-today' : ''}`}>
                      <span>{fmt(d.at, tz, { weekday: 'short' })}</span>
                      <strong>{fmt(d.at, tz, { day: 'numeric' })}</strong>
                    </div>
                    <div className="sched-slots">
                      {loadingSlots ? (
                        <>
                          <span className="skeleton sched-skel" />
                          <span className="skeleton sched-skel" />
                        </>
                      ) : list.length ? (
                        list.map((s) => (
                          <button
                            type="button"
                            key={s.startTime}
                            className={`sched-slot${picked?.startTime === s.startTime ? ' is-picked' : ''}`}
                            onClick={() => setPicked(s)}
                          >
                            {timeLabel(s.startTime, tz)}
                          </button>
                        ))
                      ) : (
                        <span className="sched-none">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {slotsError && (
              <div className="ai-error" style={{ marginTop: 10 }}>
                <Icon name="alert" size={14} /> {slotsError}
              </div>
            )}
            {!loadingSlots && !slotsError && typeUri && slots.length === 0 && (
              <div className="sched-week-empty">
                No open times this week. <button type="button" className="link-btn" onClick={jumpToNext}>Jump to the next opening →</button>
              </div>
            )}

            <div className={`sched-confirm${picked ? ' is-on' : ''}`}>
              {picked ? (
                <>
                  <div className="sched-confirm-when">
                    <Icon name="clock" size={16} />
                    <div>
                      <strong>{fmt(picked.startTime, tz, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
                      <span>
                        {timeLabel(picked.startTime, tz)}
                        {type?.duration ? ` – ${timeLabel(new Date(picked.startTime).getTime() + type.duration * 60000, tz)}` : ''} · {tzShort(tz, picked.startTime)}
                      </span>
                    </div>
                  </div>
                  {(requiredQs.length > 0 || needsPhone) && (
                    <div className="sched-questions">
                      {needsPhone && (
                        <label>
                          Phone number to call
                          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 416 555 0100" />
                        </label>
                      )}
                      {requiredQs.map((q) => (
                        <label key={q.name}>
                          {q.name}
                          {q.choices?.length ? (
                            <select value={answers[q.name] || ''} onChange={(e) => setAnswers({ ...answers, [q.name]: e.target.value })}>
                              <option value="">Choose…</option>
                              {q.choices.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input value={answers[q.name] || ''} onChange={(e) => setAnswers({ ...answers, [q.name]: e.target.value })} placeholder="Answer (filled automatically if left blank)" />
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                  {bookError && (
                    <div className="ai-error">
                      <Icon name="alert" size={14} /> {bookError.message}
                    </div>
                  )}
                  <div className="sched-confirm-actions">
                    {onInsert && (
                      <button type="button" className="secondary" onClick={insertSlotLink}>
                        <Icon name="link" size={15} /> Send link to this time
                      </button>
                    )}
                    <button type="button" onClick={book} disabled={booking || !/^\S+@\S+\.\S+$/.test(email)}>
                      <Icon name="calendarPlus" size={15} /> {booking ? 'Booking…' : 'Book on Calendly'}
                    </button>
                  </div>
                </>
              ) : (
                <span className="muted">Pick a time to continue.</span>
              )}
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}

function tzShort(tz, at) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(at || Date.now()));
    return p.find((x) => x.type === 'timeZoneName')?.value || tz;
  } catch {
    return tz;
  }
}

function locationLabel(kind) {
  return (
    {
      physical: 'In person',
      outbound_call: 'Phone (you call)',
      inbound_call: 'Phone (they call)',
      zoom_conference: 'Zoom',
      google_conference: 'Google Meet',
      microsoft_teams_conference: 'Teams',
      webex_conference: 'Webex',
      ask_invitee: 'Location TBD',
      custom: 'Custom',
    }[kind] || kind
  );
}

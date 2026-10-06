import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Avatar, bytes, formatAddress, fullTime, listTime, LOT_STATUS_LABEL } from '../../mailUtil.jsx';
import Icon from '../ui/Icon.jsx';
import Modal from '../ui/Modal.jsx';
import { useToast } from '../ui/Toast.jsx';
import CalendlyScheduler from '../CalendlyScheduler.jsx';
import Composer from './Composer.jsx';
import MessageBody from './MessageBody.jsx';

function forwardSubject(s) {
  return /^(fw|fwd)\s*:/i.test(s || '') ? s : `Fwd: ${s || ''}`;
}

function attachmentIcon(type) {
  if (/^image\//.test(type)) return 'image';
  return 'file';
}

function MessageCard({ m, expanded, onToggle, tz, allowImages, onAllowImages, onReply, onSchedule, isLast }) {
  const recipients = [...(m.to || []), ...(m.cc || [])];
  if (!expanded) {
    return (
      <button type="button" className="msg is-collapsed" onClick={onToggle}>
        <Avatar person={m.from} size={28} />
        <span className="msg-c-from">{m.direction === 'out' ? 'You' : m.from?.name || m.from?.email}</span>
        <span className="msg-c-snippet">{m.snippet}</span>
        {m.attachments?.length > 0 && <Icon name="paperclip" size={13} className="muted" />}
        <span className="msg-c-time">{listTime(m.date, tz)}</span>
      </button>
    );
  }
  return (
    <article className={`msg${m.direction === 'out' ? ' is-out' : ''}${!m.isRead && m.direction === 'in' ? ' is-unread' : ''}`}>
      <header className="msg-head" onClick={isLast ? undefined : onToggle}>
        <Avatar person={m.from} size={36} />
        <div className="msg-who">
          <div className="msg-from">
            <strong>{m.from?.name || m.from?.email}</strong>
            {m.from?.name && <span className="msg-email">&lt;{m.from.email}&gt;</span>}
            {m.direction === 'out' && <span className="pill pill-slate">You</span>}
          </div>
          <div className="msg-to" title={recipients.map(formatAddress).join(', ')}>
            to {recipients.map((r) => r.name || r.email).join(', ') || '—'}
          </div>
        </div>
        <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
          <span className="msg-time" title={fullTime(m.date, tz)}>
            {fullTime(m.date, tz)}
          </span>
          {m.direction === 'in' && (
            <button type="button" className="icon-btn" onClick={() => onSchedule(m.from)} title={`Schedule with ${m.from?.name || m.from?.email}`}>
              <Icon name="calendarPlus" size={16} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => onReply('reply', m)} title="Reply">
            <Icon name="reply" size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={() => onReply('forward', m)} title="Forward">
            <Icon name="forward" size={16} />
          </button>
        </div>
      </header>
      <MessageBody html={m.html} text={m.text} allowImages={allowImages} onAllowImages={onAllowImages} />
      {m.attachments?.length > 0 && (
        <div className="msg-attachments">
          {m.attachments.map((a) => (
            <a
              key={a._id}
              className={`att${a.tooLarge ? ' is-disabled' : ''}`}
              href={`/api/inbox/attachments/${a._id}`}
              target="_blank"
              rel="noreferrer"
              title={a.tooLarge ? 'Too large to keep — open it in your mail client' : `Download ${a.filename}`}
            >
              <span className="att-icon">
                <Icon name={attachmentIcon(a.contentType)} size={18} />
              </span>
              <span className="att-text">
                <span className="att-name">{a.filename}</span>
                <span className="att-size">{bytes(a.size)}</span>
              </span>
              <Icon name="download" size={14} className="att-dl" />
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function SaveToKnowledge({ open, onClose, thread, onSaved }) {
  const [title, setTitle] = useState(thread?.subject || '');
  const [note, setNote] = useState('');
  const [type, setType] = useState('thread');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  useEffect(() => {
    if (open) {
      setTitle(thread?.subject || '');
      setNote('');
      setError('');
    }
  }, [open, thread?.subject]);
  async function save() {
    setSaving(true);
    setError('');
    try {
      const entry = await api.post('/api/knowledge/from-thread', { threadId: thread._id, title, note, type });
      toast.push(thread.knowledgeEntry ? 'Knowledge base entry updated' : 'Saved to your knowledge base');
      onSaved(entry);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<Icon name="book" size={18} />}
      title={thread?.knowledgeEntry ? 'Update in knowledge base' : 'Add to knowledge base'}
      subtitle="Claude studies saved conversations to learn how you reply. Your messages are marked as yours."
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : thread?.knowledgeEntry ? 'Update entry' : 'Save to knowledge base'}
          </button>
        </>
      }
    >
      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <label>Save as</label>
      <div className="seg">
        <button type="button" className={type === 'thread' ? 'active' : ''} onClick={() => setType('thread')}>
          <Icon name="layers" size={14} /> Conversation
        </button>
        <button type="button" className={type === 'example' ? 'active' : ''} onClick={() => setType('example')}>
          <Icon name="mail" size={14} /> Example of my writing
        </button>
      </div>
      <label>What should Claude learn from it? (optional)</label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. How I handle walkthrough requests — offer two mornings, mention the 60-minute length." />
      {error && <div className="composer-error">{error}</div>}
    </Modal>
  );
}

export default function ThreadView({ threadId, accounts, tz, aiStatus, calendlyConnected, onChanged, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(new Set());
  const [composer, setComposer] = useState(null); // { mode, replyTo, initial, key }
  const [scheduler, setScheduler] = useState(null); // person
  const [kbOpen, setKbOpen] = useState(false);
  const [insert, setInsert] = useState(null);
  const [allowImages, setAllowImages] = useState(() => localStorage.getItem('inbox:images') === '1');
  const toast = useToast();
  const composerRef = useRef(null);

  const load = useCallback(
    async (markRead) => {
      try {
        const d = await api.get(`/api/inbox/threads/${threadId}${markRead ? '?markRead=1' : ''}`);
        setData(d);
        setError('');
        const msgs = d.messages;
        setExpanded((prev) => {
          if (prev.size) return prev;
          const s = new Set();
          msgs.forEach((m, i) => {
            if (i === msgs.length - 1 || (!m.isRead && m.direction === 'in')) s.add(m._id);
          });
          return s;
        });
        return d;
      } catch (e) {
        setError(e.message);
        return null;
      }
    },
    [threadId]
  );

  useEffect(() => {
    setData(null);
    setExpanded(new Set());
    setComposer(null);
    load(true).then((d) => {
      if (d && d.thread.unreadCount === 0) onChanged?.({ silent: true });
    });
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastInbound = useMemo(() => [...(data?.messages || [])].reverse().find((m) => m.direction === 'in') || null, [data]);
  const lastMessage = data?.messages?.[data.messages.length - 1] || null;

  const startReply = useCallback(
    (mode, msg, opts = {}) => {
      if (!data) return;
      const target = msg || lastInbound || lastMessage;
      if (!target) return;
      const selfEmail = data.account?.email;
      let to = [];
      let cc = [];
      if (mode === 'reply' || mode === 'replyAll') {
        const base = target.direction === 'out' ? target.to : target.replyTo?.length ? target.replyTo : [target.from];
        to = base.filter((p) => p?.email && p.email !== selfEmail);
        if (mode === 'replyAll') {
          const seen = new Set([selfEmail, ...to.map((p) => p.email)]);
          cc = [...(target.to || []), ...(target.cc || [])].filter((p) => p?.email && !seen.has(p.email) && seen.add(p.email));
        }
      }
      setComposer({
        key: Date.now(),
        mode,
        replyTo: target,
        autoDraft: Boolean(opts.autoDraft),
        initial: { to, cc, subject: mode === 'forward' ? forwardSubject(data.thread.subject) : target.subject, html: '' },
      });
      setTimeout(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    },
    [data, lastInbound, lastMessage]
  );

  async function act(change, message) {
    try {
      const r = await api.patch(`/api/inbox/threads/${threadId}`, change);
      setData((d) => (d ? { ...d, thread: { ...d.thread, ...r.thread } } : d));
      onChanged?.({ removed: change.archived === true || change.trashed === true });
      if (message) {
        toast.push(message, {
          action:
            change.archived === true
              ? { label: 'Undo', onClick: () => api.patch(`/api/inbox/threads/${threadId}`, { archived: false }).then(() => onChanged?.({})) }
              : change.trashed === true
                ? { label: 'Undo', onClick: () => api.patch(`/api/inbox/threads/${threadId}`, { trashed: false }).then(() => onChanged?.({})) }
                : undefined,
        });
      }
      if (change.archived === true || change.trashed === true) onClose?.();
    } catch (e) {
      toast.push(e.message, { kind: 'err' });
    }
  }

  // Keyboard: r reply, a reply all, f forward, e archive, s star, # trash.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (!data) return;
      if (e.key === 'r') (e.preventDefault(), startReply('reply'));
      else if (e.key === 'a') (e.preventDefault(), startReply('replyAll'));
      else if (e.key === 'f') (e.preventDefault(), startReply('forward'));
      else if (e.key === 'e') (e.preventDefault(), act({ archived: !data.thread.archived }, data.thread.archived ? 'Moved to Inbox' : 'Archived'));
      else if (e.key === 's') (e.preventDefault(), act({ starred: !data.thread.starred }));
      else if (e.key === '#') (e.preventDefault(), act({ trashed: true }, 'Moved to Trash'));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="reader-empty">
        <Icon name="alert" size={28} />
        <div>{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="reader">
        <div className="reader-head">
          <div className="skeleton" style={{ height: 26, width: '55%' }} />
          <div className="skeleton" style={{ height: 16, width: '30%', marginTop: 10 }} />
        </div>
        <div className="reader-scroll">
          {[0, 1].map((i) => (
            <div className="msg" key={i}>
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { thread, account, messages } = data;
  const people = thread.participants || [];
  const lot = thread.lot;
  const items = [
    ...messages.map((m) => ({ kind: 'msg', at: new Date(m.date).getTime(), m })),
    ...(thread.notes || []).map((n) => ({ kind: 'note', at: new Date(n.at).getTime(), n })),
  ].sort((a, b) => a.at - b.at);

  // Collapse long runs of read messages in the middle into one "N older" row.
  const firstExpandedIdx = messages.findIndex((m) => expanded.has(m._id));
  const hiddenMiddle = messages.length > 4 && firstExpandedIdx > 2 && expanded.size < messages.length;

  return (
    <div className="reader">
      <div className="reader-head">
        <div className="reader-title-row">
          <h2 className="reader-subject">{thread.subject || '(no subject)'}</h2>
          <div className="reader-tools">
            <button type="button" className="icon-btn" onClick={() => act({ starred: !thread.starred })} title={thread.starred ? 'Unstar (s)' : 'Star (s)'}>
              <Icon name="star" size={17} className={thread.starred ? 'is-starred' : ''} />
            </button>
            <button type="button" className="icon-btn" onClick={() => act({ read: false }, 'Marked as unread')} title="Mark unread">
              <Icon name="envelopeOpen" size={17} />
            </button>
            <button type="button" className="icon-btn" onClick={() => act({ archived: !thread.archived }, thread.archived ? 'Moved to Inbox' : 'Archived')} title={thread.archived ? 'Move to Inbox (e)' : 'Archive (e)'}>
              <Icon name={thread.archived ? 'inbox' : 'archive'} size={17} />
            </button>
            <button type="button" className="icon-btn" onClick={() => act({ trashed: !thread.trashed }, thread.trashed ? 'Restored' : 'Moved to Trash')} title={thread.trashed ? 'Restore' : 'Delete (#)'}>
              <Icon name={thread.trashed ? 'restore' : 'trash'} size={17} />
            </button>
          </div>
        </div>
        <div className="reader-meta">
          {account && (
            <span className="pill pill-account" title={account.email}>
              <i style={{ background: account.color }} />
              {account.label || account.email}
            </span>
          )}
          {lot && (
            <Link to={`/lots/${lot._id}`} className={`pill pill-lot status-${lot.status}`} title="Open lot">
              <Icon name="home" size={12} />
              Lot {lot.lotNumber}
              {lot.project?.name ? ` · ${lot.project.name}` : ''}
              <span className="pill-sep">{LOT_STATUS_LABEL[lot.status] || lot.status}</span>
            </Link>
          )}
          {lot?.appointment && (
            <span className="pill pill-green">
              <Icon name="calendar" size={12} /> {fullTime(lot.appointment.startTime, tz)}
            </span>
          )}
          <button type="button" className={`pill pill-kb${thread.knowledgeEntry ? ' is-on' : ''}`} onClick={() => setKbOpen(true)} title="Save this conversation so Claude learns from it">
            <Icon name="bookmark" size={12} />
            {thread.knowledgeEntry ? 'In knowledge base' : 'Add to knowledge base'}
          </button>
        </div>
        {people.length > 0 && (
          <div className="reader-people">
            {people.slice(0, 6).map((p) => (
              <span className="person" key={p.email}>
                <Avatar person={p} size={24} />
                <span className="person-text">
                  <span className="person-name">{p.name || p.email}</span>
                  {p.name && <span className="person-email">{p.email}</span>}
                </span>
                <button type="button" className="person-sched" onClick={() => setScheduler(p)} title={`Schedule ${p.name || p.email} on Calendly`}>
                  <Icon name="calendarPlus" size={14} /> Schedule
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="reader-scroll">
        {items.map((it) => {
          if (it.kind === 'note') {
            return (
              <div className="thread-note" key={it.n._id}>
                <span className="thread-note-icon">
                  <Icon name={it.n.kind === 'calendly' ? 'calendar' : 'info'} size={14} />
                </span>
                <span>{it.n.text}</span>
                <span className="muted">{listTime(it.n.at, tz)}</span>
              </div>
            );
          }
          const m = it.m;
          const idx = messages.indexOf(m);
          if (hiddenMiddle && idx >= 1 && idx < firstExpandedIdx) {
            if (idx !== 1) return null;
            return (
              <button type="button" key="more" className="msg-more" onClick={() => setExpanded(new Set(messages.map((x) => x._id)))}>
                <span className="msg-more-count">{firstExpandedIdx - 1}</span> older messages
              </button>
            );
          }
          return (
            <MessageCard
              key={m._id}
              m={m}
              tz={tz}
              isLast={idx === messages.length - 1}
              expanded={expanded.has(m._id)}
              onToggle={() =>
                setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(m._id)) n.delete(m._id);
                  else n.add(m._id);
                  return n;
                })
              }
              allowImages={allowImages}
              onAllowImages={() => setAllowImages(true)}
              onReply={startReply}
              onSchedule={setScheduler}
            />
          );
        })}

        <div ref={composerRef}>
          {composer ? (
            <Composer
              key={composer.key}
              mode={composer.mode}
              accounts={accounts}
              defaultAccountId={account?._id}
              thread={thread}
              replyTo={composer.replyTo}
              initial={composer.initial}
              ai={aiStatus}
              calendlyConnected={calendlyConnected}
              insert={insert}
              autoDraft={composer.autoDraft}
              onSchedule={() => setScheduler(composer.initial?.to?.[0] || lastInbound?.from || people[0])}
              onCancel={() => setComposer(null)}
              onSent={async () => {
                setComposer(null);
                toast.push('Sent');
                await load(false);
                onChanged?.({});
              }}
            />
          ) : (
            <div className="reply-bar">
              <button type="button" className="reply-btn" onClick={() => startReply('reply')}>
                <Icon name="reply" size={15} /> Reply
              </button>
              {(lastInbound?.to?.length || 0) + (lastInbound?.cc?.length || 0) > 1 && (
                <button type="button" className="reply-btn" onClick={() => startReply('replyAll')}>
                  <Icon name="replyAll" size={15} /> Reply all
                </button>
              )}
              <button type="button" className="reply-btn" onClick={() => startReply('forward')}>
                <Icon name="forward" size={15} /> Forward
              </button>
              <div style={{ flex: 1 }} />
              {lastInbound && (
                <button type="button" className="reply-btn is-ai" onClick={() => startReply('reply', null, { autoDraft: true })} title={aiStatus?.configured ? 'Open a reply and let Claude draft it' : 'Connect Claude in Integrations'}>
                  <Icon name="sparkles" size={15} /> Draft with Claude
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <CalendlyScheduler
        open={Boolean(scheduler)}
        onClose={() => setScheduler(null)}
        person={scheduler}
        threadId={thread._id}
        defaultTz={tz}
        onInsert={(html) => {
          if (!composer) {
            const target = lastInbound || lastMessage;
            setComposer({
              key: Date.now(),
              mode: 'reply',
              replyTo: target,
              initial: {
                to: scheduler?.email ? [{ name: scheduler.name || '', email: scheduler.email }] : [],
                cc: [],
                subject: target?.subject,
                html,
              },
            });
            setTimeout(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
          } else {
            setInsert({ id: Date.now(), html });
          }
        }}
        onBooked={() => {
          load(false);
          toast.push('Booked on Calendly — invitation sent');
        }}
      />
      <SaveToKnowledge
        open={kbOpen}
        onClose={() => setKbOpen(false)}
        thread={thread}
        onSaved={(entry) => {
          setData((d) => ({ ...d, thread: { ...d.thread, knowledgeEntry: entry._id } }));
          onChanged?.({ silent: true });
        }}
      />
    </div>
  );
}

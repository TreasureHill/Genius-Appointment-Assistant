import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { relativeTime } from '../time';
import { Avatar, listTime, LOT_STATUS_LABEL } from '../mailUtil.jsx';
import Icon from '../components/ui/Icon.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import ThreadView from '../components/inbox/ThreadView.jsx';
import Composer from '../components/inbox/Composer.jsx';

// The unified inbox: every connected mailbox (Microsoft 365 and IMAP) in one
// list, a reader with Claude drafting and Calendly scheduling, and folders
// that tie mail back to lots and the knowledge base.

const VIEWS = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'unread', label: 'Unread', icon: 'mail' },
  { id: 'starred', label: 'Starred', icon: 'star' },
  { id: 'sent', label: 'Sent', icon: 'send' },
  { id: 'all', label: 'All mail', icon: 'layers' },
  { id: 'archived', label: 'Archived', icon: 'archive' },
  { id: 'lots', label: 'Homeowners', icon: 'home', hint: 'Threads with a lot buyer' },
  { id: 'knowledge', label: 'In knowledge base', icon: 'bookmark' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
];

function SyncDot({ state }) {
  const map = { syncing: 'is-syncing', ok: 'is-ok', error: 'is-err', needs_auth: 'is-err', idle: 'is-idle' };
  return <span className={`sync-dot ${map[state] || 'is-idle'}`} />;
}

function ThreadRow({ t, active, tz, showAccount, onOpen, onStar, onArchive }) {
  const unread = t.unreadCount > 0;
  const people = t.participants?.length ? t.participants : [t.lastFrom];
  const names =
    t.lastDirection === 'out' && !t.unreadCount
      ? `To: ${people.map((p) => (p.name || p.email || '').split(' ')[0]).filter(Boolean).slice(0, 3).join(', ')}`
      : people
          .map((p) => (people.length > 1 ? (p.name || p.email || '').split(/[\s@]/)[0] : p.name || p.email))
          .filter(Boolean)
          .slice(0, 3)
          .join(', ');
  return (
    <div
      className={`trow${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      style={showAccount && t.account?.color ? { '--acct': t.account.color } : undefined}
    >
      {showAccount && <span className="trow-acct" title={t.account?.email} />}
      <Avatar person={people[0] || t.lastFrom} size={34} />
      <div className="trow-main">
        <div className="trow-top">
          <span className="trow-names">
            {names || '(unknown)'}
            {t.messageCount > 1 && <span className="trow-count">{t.messageCount}</span>}
          </span>
          <span className="trow-time">{listTime(t.lastMessageAt, tz)}</span>
        </div>
        <div className="trow-subject">{t.subject || '(no subject)'}</div>
        <div className="trow-bottom">
          <span className="trow-snippet">{t.snippet}</span>
        </div>
        {(t.lot || t.inKnowledgeBase || t.hasAttachments) && (
          <div className="trow-tags">
            {t.lot && (
              <span className={`pill pill-lot status-${t.lot.status}`}>
                <Icon name="home" size={11} /> Lot {t.lot.lotNumber}
                {t.lot.project?.name ? ` · ${t.lot.project.name}` : ''}
                <span className="pill-sep">{LOT_STATUS_LABEL[t.lot.status] || t.lot.status}</span>
              </span>
            )}
            {t.inKnowledgeBase && (
              <span className="pill pill-kb is-on">
                <Icon name="bookmark" size={11} /> KB
              </span>
            )}
            {t.hasAttachments && <Icon name="paperclip" size={13} className="muted" />}
          </div>
        )}
      </div>
      <div className="trow-hover" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn" onClick={onArchive} title={t.archived ? 'Move to Inbox' : 'Archive'}>
          <Icon name={t.archived ? 'inbox' : 'archive'} size={15} />
        </button>
      </div>
      <button
        type="button"
        className={`trow-star${t.starred ? ' is-on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
        aria-label={t.starred ? 'Unstar' : 'Star'}
      >
        <Icon name="star" size={15} />
      </button>
    </div>
  );
}

function Onboarding() {
  return (
    <div className="inbox-onboard">
      <div className="inbox-onboard-art">
        <Icon name="inbox" size={34} />
      </div>
      <h2>Bring your email in</h2>
      <p className="muted">
        Connect your mailbox to read and answer every conversation here — with Claude drafting replies in your voice and one-click Calendly booking.
      </p>
      <div className="inbox-onboard-actions">
        <Link to="/integrations?connect=microsoft" className="onboard-btn is-primary">
          <span className="ms-logo" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          Connect Microsoft 365
        </Link>
        <Link to="/integrations?connect=imap" className="onboard-btn">
          <Icon name="mail" size={16} /> Other email (IMAP)
        </Link>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        treasurehill.com runs on Microsoft 365 — use the first option.
      </div>
    </div>
  );
}

export default function Inbox() {
  const { threadId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'inbox';
  const accountFilter = params.get('account') || '';
  const q = params.get('q') || '';
  const { timezone: tz } = useTimezone();
  const toast = useToast();

  const [status, setStatus] = useState(null);
  const [ai, setAi] = useState(null);
  const [threads, setThreads] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(q);
  const [composeNew, setComposeNew] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const searchRef = useRef(null);
  const lastSignature = useRef('');

  const qs = useCallback(
    (p = 1) => {
      const s = new URLSearchParams({ view, page: String(p), limit: '50' });
      if (accountFilter) s.set('account', accountFilter);
      if (q) s.set('q', q);
      return s.toString();
    },
    [view, accountFilter, q]
  );

  const loadThreads = useCallback(
    async ({ quiet } = {}) => {
      if (!quiet) setLoading(true);
      try {
        const r = await api.get(`/api/inbox/threads?${qs(1)}`);
        setThreads(r.threads);
        setTotal(r.total);
        setPage(1);
        setHasMore(r.hasMore);
      } catch (e) {
        if (!quiet) toast.push(e.message, { kind: 'err' });
      } finally {
        setLoading(false);
      }
    },
    [qs, toast]
  );

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.get('/api/inbox/status');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    loadStatus();
    api.get('/api/ai/status').then(setAi).catch(() => setAi({ configured: false }));
  }, [loadStatus]);

  // Poll: when any mailbox finishes a sync with news, refresh the list quietly.
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await loadStatus();
      if (!s) return;
      const sig = s.accounts.map((a) => `${a._id}:${a.sync?.lastSyncAt}:${a.unread}`).join('|');
      if (lastSignature.current && sig !== lastSignature.current) loadThreads({ quiet: true });
      lastSignature.current = sig;
    }, 15000);
    return () => clearInterval(t);
  }, [loadStatus, loadThreads]);

  useEffect(() => setSearch(q), [q]);

  function setParam(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key === 'q' });
  }

  function openThread(id) {
    setComposeNew(null);
    navigate({ pathname: `/inbox/${id}`, search: params.toString() });
  }

  async function loadMore() {
    const r = await api.get(`/api/inbox/threads?${qs(page + 1)}`);
    setThreads((list) => [...list, ...r.threads]);
    setPage(page + 1);
    setHasMore(r.hasMore);
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await api.post('/api/inbox/sync', {});
      const failed = (r.results || []).filter((x) => !x.ok && !x.skipped);
      if (failed.length) toast.push(failed[0].message, { kind: 'err' });
      else toast.push('Mailboxes are up to date', { kind: 'info' });
      await Promise.all([loadThreads({ quiet: true }), loadStatus()]);
    } catch (e) {
      toast.push(e.message, { kind: 'err' });
    } finally {
      setSyncing(false);
    }
  }

  async function quickAct(t, change) {
    try {
      await api.patch(`/api/inbox/threads/${t._id}`, change);
      if (change.archived !== undefined || change.trashed !== undefined) {
        setThreads((list) => list.filter((x) => x._id !== t._id));
        setTotal((n) => Math.max(0, n - 1));
        if (threadId === t._id) navigate({ pathname: '/inbox', search: params.toString() });
        toast.push(change.archived ? 'Archived' : 'Moved to Inbox', {
          action: { label: 'Undo', onClick: () => api.patch(`/api/inbox/threads/${t._id}`, { archived: !change.archived }).then(() => loadThreads({ quiet: true })) },
        });
      } else {
        setThreads((list) => list.map((x) => (x._id === t._id ? { ...x, ...change } : x)));
      }
      loadStatus();
    } catch (e) {
      toast.push(e.message, { kind: 'err' });
    }
  }

  // j / k move through the list, c composes, / searches.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'c') {
        e.preventDefault();
        startCompose();
      } else if (e.key === 'j' || e.key === 'k') {
        if (!threads.length) return;
        e.preventDefault();
        const i = threads.findIndex((t) => t._id === threadId);
        const next = e.key === 'j' ? Math.min(threads.length - 1, i + 1) : Math.max(0, i - 1);
        openThread(threads[i === -1 ? 0 : next]._id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function startCompose(prefill = {}) {
    navigate({ pathname: '/inbox', search: params.toString() });
    setComposeNew({ key: Date.now(), ...prefill });
  }

  const accounts = status?.accounts || [];
  const enabledAccounts = accounts.filter((a) => a.enabled);
  const defaultAccount = enabledAccounts.find((a) => a.isDefault) || enabledAccounts[0];
  const viewInfo = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const anySyncing = accounts.some((a) => a.sync?.state === 'syncing');
  const firstSync = accounts.length > 0 && accounts.every((a) => !a.sync?.initialDone);
  const lastSyncAt = useMemo(() => {
    const times = accounts.map((a) => (a.sync?.lastSyncAt ? new Date(a.sync.lastSyncAt).getTime() : 0));
    return times.length ? Math.max(...times) : 0;
  }, [accounts]);

  if (status && accounts.length === 0) {
    return (
      <div className="inbox inbox-empty-state">
        <Onboarding />
      </div>
    );
  }

  return (
    <div className="inbox">
      <aside className="inbox-rail">
        <button type="button" className="compose-btn" onClick={() => startCompose()} disabled={!enabledAccounts.length}>
          <Icon name="pencil" size={16} /> New message
        </button>
        <nav className="rail-nav">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={`rail-item${view === v.id ? ' is-active' : ''}`}
              onClick={() => setParam('view', v.id === 'inbox' ? '' : v.id)}
              title={v.hint}
            >
              <Icon name={v.icon} size={16} />
              <span>{v.label}</span>
              {v.id === 'inbox' && status?.unread > 0 && <span className="rail-count">{status.unread}</span>}
            </button>
          ))}
        </nav>
        <div className="rail-section">
          <div className="rail-heading">
            Mailboxes
            <Link to="/integrations" className="rail-manage" title="Manage mailboxes">
              <Icon name="plus" size={14} />
            </Link>
          </div>
          <button type="button" className={`rail-item${!accountFilter ? ' is-active-soft' : ''}`} onClick={() => setParam('account', '')}>
            <Icon name="users" size={16} />
            <span>All mailboxes</span>
          </button>
          {accounts.map((a) => (
            <button
              type="button"
              key={a._id}
              className={`rail-item rail-acct${accountFilter === a._id ? ' is-active-soft' : ''}${a.enabled ? '' : ' is-off'}`}
              onClick={() => setParam('account', accountFilter === a._id ? '' : a._id)}
              title={`${a.email}${a.sync?.message ? ` — ${a.sync.message}` : ''}`}
            >
              <i className="acct-dot" style={{ background: a.color }} />
              <span className="rail-acct-name">{a.label || a.email}</span>
              {a.sync?.state === 'error' || a.sync?.state === 'needs_auth' ? <Icon name="alert" size={13} className="rail-warn" /> : a.unread > 0 ? <span className="rail-count is-soft">{a.unread}</span> : null}
            </button>
          ))}
        </div>
        <div className="rail-foot">
          <button type="button" className="rail-sync" onClick={syncNow} disabled={syncing}>
            <Icon name="refresh" size={14} className={syncing || anySyncing ? 'spin' : ''} />
            {syncing || anySyncing ? 'Syncing…' : 'Sync now'}
          </button>
          <span className="muted">{lastSyncAt ? `Updated ${relativeTime(new Date(lastSyncAt))}` : ''}</span>
        </div>
      </aside>

      <section className="inbox-list">
        <div className="list-head">
          <div className="list-search">
            <Icon name="search" size={15} />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setParam('q', search.trim());
                if (e.key === 'Escape') {
                  setSearch('');
                  setParam('q', '');
                  e.currentTarget.blur();
                }
              }}
              placeholder="Search mail, people, lots…"
              aria-label="Search mail"
            />
            {q ? (
              <button type="button" className="icon-btn" onClick={() => (setSearch(''), setParam('q', ''))} aria-label="Clear search">
                <Icon name="x" size={14} />
              </button>
            ) : (
              <kbd className="list-kbd">/</kbd>
            )}
          </div>
          <div className="list-title-row">
            <div className="list-title">
              {q ? `Results for “${q}”` : viewInfo.label}
              <span className="list-total">{total.toLocaleString()}</span>
            </div>
            <button type="button" className="icon-btn" onClick={() => loadThreads()} title="Refresh">
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </div>
        <div className="list-scroll">
          {firstSync && (
            <div className="list-banner">
              <Icon name="refresh" size={14} className="spin" /> Reading your mailbox for the first time — messages appear as they arrive.
            </div>
          )}
          {loading && !threads.length ? (
            Array.from({ length: 7 }).map((_, i) => (
              <div className="trow is-skel" key={i}>
                <span className="skeleton" style={{ width: 34, height: 34, borderRadius: '50%' }} />
                <div className="trow-main">
                  <span className="skeleton" style={{ height: 12, width: '45%' }} />
                  <span className="skeleton" style={{ height: 12, width: '80%', marginTop: 8 }} />
                  <span className="skeleton" style={{ height: 11, width: '65%', marginTop: 6 }} />
                </div>
              </div>
            ))
          ) : threads.length ? (
            <>
              {threads.map((t) => (
                <ThreadRow
                  key={t._id}
                  t={t}
                  tz={tz}
                  active={t._id === threadId}
                  showAccount={accounts.length > 1}
                  onOpen={() => openThread(t._id)}
                  onStar={() => quickAct(t, { starred: !t.starred })}
                  onArchive={() => quickAct(t, { archived: !t.archived })}
                />
              ))}
              {hasMore && (
                <button type="button" className="list-more" onClick={loadMore}>
                  Load more
                </button>
              )}
            </>
          ) : (
            <div className="list-empty">
              <Icon name={q ? 'search' : viewInfo.icon} size={26} />
              <div>{q ? 'No conversations match.' : view === 'inbox' ? 'Inbox zero. Nicely done.' : `Nothing in ${viewInfo.label.toLowerCase()}.`}</div>
            </div>
          )}
        </div>
      </section>

      <section className="inbox-reader">
        {composeNew ? (
          <div className="reader">
            <div className="reader-head">
              <div className="reader-title-row">
                <h2 className="reader-subject">New message</h2>
              </div>
            </div>
            <div className="reader-scroll">
              <Composer
                key={composeNew.key}
                mode="new"
                accounts={enabledAccounts}
                defaultAccountId={defaultAccount?._id}
                initial={{ to: composeNew.to || [], cc: [], subject: '', html: '' }}
                ai={ai}
                calendlyConnected={status?.calendly?.configured}
                onCancel={() => setComposeNew(null)}
                onSent={(r) => {
                  setComposeNew(null);
                  toast.push('Sent');
                  loadThreads({ quiet: true });
                  if (r?.threadId) navigate({ pathname: `/inbox/${r.threadId}`, search: params.toString() });
                }}
              />
            </div>
          </div>
        ) : threadId ? (
          <ThreadView
            key={threadId}
            threadId={threadId}
            accounts={enabledAccounts}
            tz={tz}
            aiStatus={ai}
            calendlyConnected={status?.calendly?.configured}
            onClose={() => navigate({ pathname: '/inbox', search: params.toString() })}
            onChanged={({ removed } = {}) => {
              if (removed) setThreads((list) => list.filter((x) => x._id !== threadId));
              loadStatus();
              loadThreads({ quiet: true });
            }}
          />
        ) : (
          <div className="reader-empty">
            <div className="reader-empty-art">
              <Icon name="mail" size={30} />
            </div>
            <div className="reader-empty-title">{status?.unread ? `${status.unread} unread conversation${status.unread === 1 ? '' : 's'}` : 'Select a conversation'}</div>
            <div className="muted">Pick a thread on the left, or start a new message.</div>
            {!ai?.configured && ai && (
              <Link to="/integrations" className="reader-empty-cta">
                <Icon name="sparkles" size={14} /> Connect Claude to draft replies in your voice
              </Link>
            )}
            <div className="shortcuts">
              <span>
                <kbd>j</kbd>
                <kbd>k</kbd> move
              </span>
              <span>
                <kbd>r</kbd> reply
              </span>
              <span>
                <kbd>e</kbd> archive
              </span>
              <span>
                <kbd>c</kbd> compose
              </span>
              <span>
                <kbd>/</kbd> search
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

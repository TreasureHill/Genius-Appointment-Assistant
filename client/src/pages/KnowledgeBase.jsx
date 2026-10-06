import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { streamPost } from '../sse';
import { relativeTime } from '../time';
import Icon from '../components/ui/Icon.jsx';
import Modal from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';

// The knowledge base Claude writes from: your voice rules, emails that show
// how you sound, whole conversations saved from the inbox, and business facts.

const TYPES = {
  style: {
    label: 'Voice & style',
    icon: 'wand',
    color: 'violet',
    blurb: 'Rules for how you sound — greetings, sign-offs, length, words you use or avoid.',
    placeholder: 'e.g.\n- Open with "Hi <first name>," — never "Dear".\n- Two or three short paragraphs.\n- Sign off "Cheers,\\nAli".\n- No exclamation marks in the first line.',
  },
  example: {
    label: 'Example emails',
    icon: 'mail',
    color: 'indigo',
    blurb: 'Emails you wrote that capture your voice. Paste a few of your best.',
    placeholder: 'Paste an email you wrote, as you sent it.',
  },
  thread: {
    label: 'Saved conversations',
    icon: 'layers',
    color: 'teal',
    blurb: 'Whole threads saved from the inbox — Claude sees how you replied in context.',
    placeholder: 'Conversations are usually added from the inbox with “Add to knowledge base”.',
  },
  fact: {
    label: 'Business facts',
    icon: 'info',
    color: 'amber',
    blurb: 'Hours, policies, process, links and answers to common questions.',
    placeholder: 'e.g. Pre-delivery walkthroughs run 60 minutes, weekdays 9 am–3 pm, at the home. Bring photo ID.',
  },
};

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function EntryEditor({ open, onClose, entry, defaultType, onSaved }) {
  const [type, setType] = useState(entry?.type || defaultType || 'style');
  const [title, setTitle] = useState(entry?.title || '');
  const [content, setContent] = useState(entry?.content || '');
  const [tags, setTags] = useState((entry?.tags || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setType(entry?.type || defaultType || 'style');
    setTitle(entry?.title || '');
    setContent(entry?.content || '');
    setTags((entry?.tags || []).join(', '));
    setError('');
  }, [open, entry, defaultType]);
  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = { type, title, content, tags };
      const saved = entry ? await api.patch(`/api/knowledge/${entry._id}`, body) : await api.post('/api/knowledge', body);
      onSaved(saved, !entry);
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
      width={720}
      icon={<Icon name={TYPES[type].icon} size={18} />}
      title={entry ? 'Edit entry' : 'Add to knowledge base'}
      subtitle="Everything enabled here is given to Claude every time it drafts."
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 12 }}>
            ≈ {fmtTokens(Math.ceil(content.length / 4))} tokens
          </span>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving || !content.trim()}>
            {saving ? 'Saving…' : entry ? 'Save changes' : 'Add entry'}
          </button>
        </>
      }
    >
      <div className="kb-type-pick">
        {Object.entries(TYPES).map(([id, t]) => (
          <button type="button" key={id} className={`kb-type-opt tone-${t.color}${type === id ? ' is-active' : ''}`} onClick={() => setType(id)}>
            <Icon name={t.icon} size={16} />
            <strong>{t.label}</strong>
            <span>{t.blurb}</span>
          </button>
        ))}
      </div>
      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name, e.g. “Walkthrough booking replies”" />
      <label>Content</label>
      <textarea className="kb-content-input" value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder={TYPES[type].placeholder} data-autofocus />
      <label>Tags (comma-separated, optional)</label>
      <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="walkthroughs, closings" />
      {error && <div className="composer-error">{error}</div>}
    </Modal>
  );
}

function LearnVoice({ open, onClose, onDone }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);
  const abort = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    setText('');
    setError('');
    setMeta(null);
    setState('running');
    const c = new AbortController();
    abort.current = c;
    let acc = '';
    streamPost('/api/knowledge/learn-style', {}, {
      signal: c.signal,
      onEvent: (e) => {
        if (e.type === 'meta') setMeta(e);
        if (e.type === 'text') {
          acc += e.text;
          setText(acc);
        }
        if (e.type === 'done') {
          setState('done');
          onDone();
        }
        if (e.type === 'error') {
          setError(e.message);
          setState('error');
        }
      },
    })
      .then(() => setState((s) => (s === 'running' ? 'done' : s)))
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setState('error');
        }
      });
    return () => c.abort();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      icon={<Icon name="sparkles" size={18} />}
      title="Learn my voice"
      subtitle={meta ? `Claude is studying ${meta.samples} samples of your writing — examples, saved conversations and recent sent mail.` : 'Collecting your writing samples…'}
      footer={
        <button type="button" onClick={onClose}>
          {state === 'done' ? 'Done' : 'Close'}
        </button>
      }
    >
      {error ? (
        <div className="ai-error">
          <Icon name="alert" size={14} /> {error}
        </div>
      ) : (
        <>
          <pre className={`kb-stream${state === 'running' ? ' is-running' : ''}`}>{text || ' '}</pre>
          {state === 'done' && (
            <div className="kb-learned">
              <Icon name="check" size={16} /> Saved as a pinned <strong>Voice &amp; style</strong> entry. Edit it any time — Claude follows it on every draft.
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function Playground({ disabled }) {
  const [incoming, setIncoming] = useState('');
  const [instructions, setInstructions] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef(null);
  async function run() {
    setBusy(true);
    setError('');
    setOut('');
    const c = new AbortController();
    abort.current = c;
    let acc = '';
    try {
      await streamPost('/api/ai/draft', { mode: 'playground', incoming, instructions }, {
        signal: c.signal,
        onEvent: (e) => {
          if (e.type === 'text') setOut((acc += e.text));
          if (e.type === 'error') setError(e.message);
        },
      });
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card kb-play">
      <div className="kb-play-head">
        <div>
          <h3>Try it</h3>
          <div className="muted">Paste an email you received and see how Claude would answer it with your current knowledge base.</div>
        </div>
      </div>
      <div className="kb-play-grid">
        <div>
          <textarea value={incoming} onChange={(e) => setIncoming(e.target.value)} rows={9} placeholder={'Hi Ali,\n\nCould we move our walkthrough to next week? Mornings are easier for us.\n\nThanks,\nJane'} />
          <div className="kb-play-row">
            <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Optional instructions, e.g. “offer Tuesday 9:30”" />
            {busy ? (
              <button type="button" className="ai-go is-stop" onClick={() => abort.current?.abort()}>
                <Icon name="stop" size={14} /> Stop
              </button>
            ) : (
              <button type="button" className="ai-go" onClick={run} disabled={disabled || !incoming.trim()}>
                <Icon name="sparkles" size={15} /> Draft reply
              </button>
            )}
          </div>
        </div>
        <div className={`kb-play-out${busy ? ' is-running' : ''}`}>
          {error ? (
            <div className="ai-error">
              <Icon name="alert" size={14} /> {error}
            </div>
          ) : out ? (
            <pre>{out}</pre>
          ) : (
            <div className="muted kb-play-empty">
              <Icon name="sparkles" size={20} />
              {disabled ? 'Connect Claude in Integrations to try this.' : 'The draft appears here.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function KnowledgeBase() {
  const [entries, setEntries] = useState(null);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // { entry } | { type }
  const [learning, setLearning] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [ai, setAi] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const r = await api.get('/api/knowledge');
    setEntries(r.entries);
    setStats(r.stats);
  }, []);

  useEffect(() => {
    load();
    api.get('/api/knowledge/profile').then(setProfile);
    api.get('/api/ai/status').then(setAi).catch(() => setAi({ configured: false }));
  }, [load]);

  const shown = useMemo(() => {
    let list = entries || [];
    if (filter !== 'all') list = list.filter((e) => e.type === filter);
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((e) => `${e.title} ${e.content} ${(e.tags || []).join(' ')}`.toLowerCase().includes(s));
    return list;
  }, [entries, filter, q]);

  async function patch(e, body) {
    const saved = await api.patch(`/api/knowledge/${e._id}`, body);
    setEntries((list) => list.map((x) => (x._id === e._id ? saved : x)));
    load();
  }

  async function remove(e) {
    if (!window.confirm(`Delete “${e.title || 'this entry'}” from the knowledge base?`)) return;
    await api.del(`/api/knowledge/${e._id}`);
    toast.push('Entry deleted');
    load();
  }

  async function saveProfile() {
    const p = await api.patch('/api/knowledge/profile', profile);
    setProfile({ ...profile, ...p });
    setProfileDirty(false);
    toast.push('Saved — Claude will write as you');
  }

  const contextPct = stats ? Math.min(100, Math.round((stats.contextTokens / 200000) * 100)) : 0;

  return (
    <div className="kb-page">
      <div className="page-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>Knowledge base</h1>
          <div className="muted">What Claude reads before drafting any email — your voice, your best emails, your conversations and your facts.</div>
        </div>
        <div className="row-actions">
          <button type="button" className="ai-go" onClick={() => setLearning(true)} disabled={!ai?.configured} title={ai?.configured ? 'Distil a voice profile from your examples and sent mail' : 'Connect Claude first'}>
            <Icon name="sparkles" size={15} /> Learn my voice
          </button>
          <button type="button" onClick={() => setEditing({ type: filter === 'all' ? 'style' : filter })}>
            <Icon name="plus" size={15} /> Add entry
          </button>
        </div>
      </div>

      {ai && !ai.configured && (
        <div className="card alert alert-warn kb-alert">
          <Icon name="sparkles" size={16} />
          <span>
            Claude isn’t connected yet. <Link to="/integrations">Add your Anthropic API key</Link> to draft replies with this knowledge base.
          </span>
        </div>
      )}

      <div className="kb-top">
        <div className="card kb-profile">
          <div className="kb-profile-head">
            <span className="kb-profile-icon">
              <Icon name="user" size={18} />
            </span>
            <div>
              <h3>Claude writes as</h3>
              <div className="muted">Used in every draft.</div>
            </div>
          </div>
          {profile && (
            <div className="kb-profile-grid">
              <label>
                Name
                <input
                  value={profile.writerName}
                  placeholder={profile.ownerName || 'Your name'}
                  onChange={(e) => (setProfile({ ...profile, writerName: e.target.value }), setProfileDirty(true))}
                />
              </label>
              <label>
                Role &amp; company
                <input value={profile.writerRole} placeholder="Customer Care, Treasure Hill" onChange={(e) => (setProfile({ ...profile, writerRole: e.target.value }), setProfileDirty(true))} />
              </label>
              <label>
                Sign-off
                <input value={profile.signOff} placeholder="Best regards," onChange={(e) => (setProfile({ ...profile, signOff: e.target.value }), setProfileDirty(true))} />
              </label>
              <div className="kb-profile-save">
                <button type="button" onClick={saveProfile} disabled={!profileDirty}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="kb-stats">
          {Object.entries(TYPES).map(([id, t]) => (
            <button type="button" key={id} className={`kb-stat tone-${t.color}${filter === id ? ' is-active' : ''}`} onClick={() => setFilter(filter === id ? 'all' : id)}>
              <span className="kb-stat-icon">
                <Icon name={t.icon} size={16} />
              </span>
              <span className="kb-stat-n">{stats?.byType?.[id] ?? '—'}</span>
              <span className="kb-stat-label">{t.label}</span>
            </button>
          ))}
          <div className="kb-context" title="Approximate size of the knowledge base Claude reads on each draft (cached between drafts, so repeat reads are cheap).">
            <div className="kb-context-top">
              <span>Context per draft</span>
              <strong>≈ {fmtTokens(stats?.contextTokens)} tokens</strong>
            </div>
            <div className="kb-meter">
              <span style={{ width: `${Math.max(2, contextPct)}%` }} />
            </div>
            <div className="muted">Cached between drafts · {stats?.enabled ?? 0} of {stats?.total ?? 0} entries on</div>
          </div>
        </div>
      </div>

      <div className="kb-toolbar">
        <div className="seg">
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          {Object.entries(TYPES).map(([id, t]) => (
            <button type="button" key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="list-search kb-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the knowledge base" />
        </div>
      </div>

      {entries === null ? (
        <div className="kb-grid">
          {[0, 1, 2].map((i) => (
            <div className="card kb-card" key={i}>
              <div className="skeleton" style={{ height: 110 }} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="card kb-empty">
          <Icon name={filter === 'all' ? 'book' : TYPES[filter].icon} size={28} />
          <h3>{entries.length ? 'Nothing matches.' : 'Teach Claude how you write'}</h3>
          <p className="muted">
            {entries.length
              ? 'Try another filter or search.'
              : 'Start with a few rules about your voice, paste two or three emails you’re proud of, and save good conversations from the inbox. Then press “Learn my voice”.'}
          </p>
          {!entries.length && (
            <div className="row-actions" style={{ justifyContent: 'center' }}>
              <button type="button" onClick={() => setEditing({ type: 'style' })}>
                <Icon name="wand" size={15} /> Write voice rules
              </button>
              <button type="button" className="secondary" onClick={() => setEditing({ type: 'example' })}>
                <Icon name="mail" size={15} /> Paste an example email
              </button>
              <Link to="/inbox" className="btn-link">
                <Icon name="inbox" size={15} /> Save a conversation from the inbox
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="kb-grid">
          {shown.map((e) => {
            const t = TYPES[e.type];
            return (
              <article key={e._id} className={`card kb-card${e.enabled ? '' : ' is-off'}`}>
                <div className="kb-card-head">
                  <span className={`kb-badge tone-${t.color}`}>
                    <Icon name={t.icon} size={12} /> {t.label}
                  </span>
                  {e.source?.generated && (
                    <span className="kb-badge tone-violet is-soft">
                      <Icon name="sparkles" size={11} /> Learned
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <button type="button" className={`icon-btn${e.pinned ? ' is-on' : ''}`} onClick={() => patch(e, { pinned: !e.pinned })} title={e.pinned ? 'Unpin' : 'Pin to the top (Claude reads pinned entries first)'}>
                    <Icon name="pin" size={14} />
                  </button>
                  <label className="switch" title={e.enabled ? 'Claude uses this entry' : 'Claude ignores this entry'}>
                    <input type="checkbox" checked={e.enabled} onChange={() => patch(e, { enabled: !e.enabled })} />
                    <span />
                  </label>
                </div>
                <h3 className="kb-card-title" onClick={() => setEditing({ entry: e })}>
                  {e.title || 'Untitled'}
                </h3>
                <div className="kb-card-body" onClick={() => setEditing({ entry: e })}>
                  {e.content}
                </div>
                <div className="kb-card-foot">
                  {(e.tags || []).map((tag) => (
                    <span key={tag} className="kb-tag">
                      #{tag}
                    </span>
                  ))}
                  {e.source?.thread && (
                    <Link to={`/inbox/${e.source.thread}`} className="kb-src">
                      <Icon name="link" size={12} /> {e.source.messageCount} messages
                    </Link>
                  )}
                  <div style={{ flex: 1 }} />
                  <span className="muted kb-meta">≈{fmtTokens(e.tokens)} · {relativeTime(new Date(e.updatedAt))}</span>
                  <button type="button" className="icon-btn" onClick={() => setEditing({ entry: e })} title="Edit">
                    <Icon name="pencil" size={14} />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => remove(e)} title="Delete">
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Playground disabled={!ai?.configured} />

      <EntryEditor
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        entry={editing?.entry || null}
        defaultType={editing?.type}
        onSaved={(saved, created) => {
          toast.push(created ? 'Added to the knowledge base' : 'Saved');
          load();
        }}
      />
      <LearnVoice open={learning} onClose={() => setLearning(false)} onDone={load} />
    </div>
  );
}

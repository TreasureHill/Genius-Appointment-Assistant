import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { relativeTime } from '../time';
import Icon from '../components/ui/Icon.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { ConnectChooser, ConnectImap, ConnectMicrosoft, EditMailbox, MsLogo } from '../components/integrations/MailboxDialogs.jsx';

// API connections: mailboxes for the unified inbox (Microsoft 365 via Graph,
// or IMAP), the Microsoft app registration behind them, Calendly, Claude and
// Resend. Keys are write-only — the server only ever reports their last four
// characters.

function Status({ ok, children }) {
  return <span className={`conn-status ${ok ? 'is-ok' : 'is-off'}`}>{children || (ok ? 'Connected' : 'Not connected')}</span>;
}

function SourceNote({ source }) {
  if (source === 'env') return <span className="muted conn-source">from .env</span>;
  if (source === 'settings') return <span className="muted conn-source">saved here, encrypted</span>;
  return null;
}

function CopyField({ value, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label && <span className="field-label">{label}</span>}
      <div className="copy-row">
        <code>{value}</code>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy"
        >
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
    </div>
  );
}

function SecretInput({ value, onChange, placeholder, hint }) {
  return <input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder={hint ? `Saved (${hint}) — paste a new one to replace` : placeholder} autoComplete="new-password" spellCheck={false} />;
}

function MailboxesSection({ data, mailboxes, reload, openConnect }) {
  const [editing, setEditing] = useState(null);
  const toast = useToast();
  async function syncOne(a) {
    const r = await api.post(`/api/mail-accounts/${a._id}/sync`);
    toast.push(r.ok ? `${a.email}: ${r.added ? `${r.added} new` : 'up to date'}` : r.message, { kind: r.ok ? 'ok' : 'err' });
    reload();
  }
  async function reconnect(a) {
    const r = await api.post('/api/mail-accounts/microsoft/connect', { accountId: a._id, mailbox: a.microsoft?.mailbox || '', loginHint: a.microsoft?.userPrincipalName || a.email, returnTo: '/integrations' });
    window.location.assign(r.url);
  }
  const list = mailboxes?.accounts || [];
  return (
    <div className="card conn-card conn-wide">
      <div className="conn-head">
        <span className="conn-logo tone-indigo">
          <Icon name="inbox" size={20} />
        </span>
        <div className="conn-title">
          <h3>Mailboxes</h3>
          <div className="muted">Every connected mailbox appears in the unified inbox. Receiving uses Microsoft 365 or IMAP — Resend isn’t needed for it.</div>
        </div>
        <button type="button" onClick={openConnect}>
          <Icon name="plus" size={15} /> Connect mailbox
        </button>
      </div>
      {list.length === 0 ? (
        <div className="conn-empty">
          <MsLogo />
          <div>
            <strong>No mailboxes yet.</strong> treasurehill.com is on Microsoft 365 (Exchange Online) — connect it with Microsoft sign-in.
          </div>
        </div>
      ) : (
        <div className="mbx-list">
          {list.map((a) => {
            const st = a.syncing ? 'syncing' : a.sync?.state;
            return (
              <div key={a._id} className={`mbx-row${a.enabled ? '' : ' is-off'}`}>
                <i className="acct-dot lg" style={{ background: a.color }} />
                <div className="mbx-main">
                  <div className="mbx-name">
                    <strong>{a.label || a.email}</strong>
                    {a.label && a.label !== a.email && <span className="muted">{a.email}</span>}
                    {a.isDefault && <span className="pill pill-slate">Default</span>}
                  </div>
                  <div className="mbx-meta">
                    <span className="pill pill-soft">{a.kind === 'microsoft' ? (a.microsoft?.authMode === 'app' ? 'Microsoft 365 · app access' : 'Microsoft 365') : `IMAP · ${a.imap?.host}`}</span>
                    <span className="muted">
                      Sends via {{ graph: 'Microsoft 365', smtp: 'SMTP', env_smtp: 'server SMTP', resend: 'Resend' }[a.outgoing?.via] || a.outgoing?.via}
                    </span>
                    {a.sync?.messageCount ? <span className="muted">· {a.sync.messageCount.toLocaleString()} messages</span> : null}
                  </div>
                </div>
                <div className={`mbx-sync is-${st || 'idle'}`} title={a.sync?.message}>
                  {st === 'syncing' ? (
                    <>
                      <Icon name="refresh" size={13} className="spin" /> Syncing…
                    </>
                  ) : st === 'needs_auth' ? (
                    <>
                      <Icon name="alert" size={13} /> Needs reconnect
                    </>
                  ) : st === 'error' ? (
                    <>
                      <Icon name="alert" size={13} /> {a.sync?.message?.slice(0, 60)}
                    </>
                  ) : a.sync?.lastOkAt ? (
                    <>
                      <Icon name="check" size={13} /> Synced {relativeTime(new Date(a.sync.lastOkAt))}
                    </>
                  ) : (
                    'Waiting for first sync'
                  )}
                </div>
                <div className="mbx-actions">
                  {st === 'needs_auth' && a.kind === 'microsoft' && (
                    <button type="button" className="ms-btn sm" onClick={() => reconnect(a)}>
                      <MsLogo /> Reconnect
                    </button>
                  )}
                  <button type="button" className="icon-btn" onClick={() => syncOne(a)} title="Sync now">
                    <Icon name="refresh" size={15} />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => setEditing(a)} title="Settings">
                    <Icon name="pencil" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <EditMailbox
        open={Boolean(editing)}
        account={editing}
        onClose={() => setEditing(null)}
        envSmtp={mailboxes?.envSmtp}
        resendReady={data?.resend?.connected}
        onSaved={() => (toast.push('Mailbox saved'), reload())}
        onRemoved={(a) => (toast.push(`${a.email} disconnected`), reload())}
        onReconnect={reconnect}
      />
    </div>
  );
}

function MicrosoftCard({ data, reload, highlight }) {
  const ms = data?.microsoft;
  const [open, setOpen] = useState(!ms?.configured);
  const [tenantId, setTenantId] = useState(ms?.tenantId || 'treasurehill.com');
  const [clientId, setClientId] = useState(ms?.clientId || '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (ms) {
      setTenantId(ms.tenantId && ms.tenantId !== 'organizations' ? ms.tenantId : 'treasurehill.com');
      setClientId(ms.clientId || '');
      setOpen(!ms.configured);
    }
  }, [ms?.configured, ms?.clientId, ms?.tenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (highlight) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [highlight]);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.put('/api/integrations/microsoft', { tenantId, clientId, clientSecret: secret || undefined });
      setMsg({ ok: true, text: r.message });
      setSecret('');
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`card conn-card conn-wide${highlight ? ' is-highlight' : ''}`} ref={ref}>
      <div className="conn-head">
        <span className="conn-logo tone-ms">
          <MsLogo />
        </span>
        <div className="conn-title">
          <h3>
            Microsoft 365 app registration <Status ok={ms?.configured} />
            <SourceNote source={ms?.source} />
          </h3>
          <div className="muted">One-time setup that lets mailboxes on Exchange Online (treasurehill.com) connect through Microsoft Graph.</div>
        </div>
        <button type="button" className="secondary" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : ms?.configured ? 'Edit' : 'Set up'}
        </button>
      </div>
      {open && (
        <div className="ms-setup">
          <ol className="steps">
            <li>
              Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Microsoft Entra admin center → App registrations</a> and choose <strong>New registration</strong>.
            </li>
            <li>
              Name it “Genius Appointment Assistant”, keep <em>Accounts in this organizational directory only</em>, and add a <strong>Web</strong> redirect URI:
              <CopyField value={ms?.redirectUri || ''} />
            </li>
            <li>
              Under <strong>API permissions</strong> → Microsoft Graph → <em>Delegated</em>, add <code>Mail.ReadWrite</code>, <code>Mail.Send</code>, <code>User.Read</code> and <code>offline_access</code>. Click{' '}
              <strong>Grant admin consent</strong> if your tenant asks for it.
            </li>
            <li>
              Under <strong>Certificates &amp; secrets</strong> create a client secret and copy its <strong>Value</strong>.
            </li>
            <li>Paste the IDs below and save — then connect a mailbox above.</li>
          </ol>
          <div className="form-grid">
            <label>
              Directory (tenant) ID or domain
              <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="treasurehill.com" />
            </label>
            <label>
              Application (client) ID
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
            </label>
            <label className="span-2">
              Client secret value
              <SecretInput value={secret} onChange={setSecret} hint={ms?.secretHint} placeholder="Paste the secret Value" />
            </label>
          </div>
          {msg && <div className={`test-result ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.text}</div>}
          <div className="conn-actions">
            <button type="button" onClick={save} disabled={busy || !clientId || (!secret && !ms?.secretHint)}>
              {busy ? 'Verifying with Microsoft…' : 'Save & verify'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CalendlyCard({ data, reload }) {
  const c = data?.calendly;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [types, setTypes] = useState([]);
  const [hooks, setHooks] = useState(null);
  const toast = useToast();
  const loadExtras = useCallback(async () => {
    if (!c?.connected) return;
    api.get('/api/calendly/event-types').then((r) => setTypes(r.eventTypes || [])).catch(() => {});
    api.get('/api/integrations/calendly/webhooks').then(setHooks).catch(() => {});
  }, [c?.connected]);
  useEffect(() => {
    loadExtras();
  }, [loadExtras]);
  async function connect() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.put('/api/integrations/calendly', { token });
      setMsg({ ok: true, text: `${r.message}${r.filled?.length ? ` · filled in your ${r.filled.join(' and ')}` : ''}` });
      setToken('');
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    const r = await api.post('/api/integrations/calendly/test');
    setMsg({ ok: r.ok, text: r.message });
    reload();
  }
  async function disconnect() {
    if (!window.confirm('Disconnect Calendly? Scheduling from the inbox and the 30-minute sync stop until you reconnect.')) return;
    const r = await api.del('/api/integrations/calendly');
    toast.push(r.stillConnectedViaEnv ? 'Removed — CALENDLY_TOKEN in .env is still active' : 'Calendly disconnected');
    reload();
  }
  async function setDefault(uri) {
    await api.patch('/api/integrations/calendly', { defaultEventTypeUri: uri });
    reload();
  }
  async function register() {
    try {
      const r = await api.post('/api/integrations/calendly/webhooks');
      toast.push(r.message);
    } catch (e) {
      toast.push(e.message, { kind: 'err' });
    }
    loadExtras();
  }
  const ours = hooks?.webhooks?.find((w) => w.ours && w.state === 'active');
  return (
    <div className="card conn-card">
      <div className="conn-head">
        <span className="conn-logo tone-calendly">
          <Icon name="calendar" size={20} />
        </span>
        <div className="conn-title">
          <h3>
            Calendly <Status ok={c?.connected} />
            <SourceNote source={c?.source} />
          </h3>
          <div className="muted">Book meetings from any email, offer real open times in drafts, and keep lots in sync.</div>
        </div>
      </div>
      {c?.connected && c.account?.name && (
        <div className="cal-acct">
          {c.account.avatarUrl ? <img src={c.account.avatarUrl} alt="" /> : <span className="cal-acct-ph">{c.account.name[0]}</span>}
          <div>
            <strong>{c.account.name}</strong>
            <div className="muted">{c.account.email}</div>
            {c.account.schedulingUrl && (
              <a href={c.account.schedulingUrl} target="_blank" rel="noreferrer" className="cal-link">
                {c.account.schedulingUrl.replace(/^https?:\/\//, '')} <Icon name="external" size={11} />
              </a>
            )}
          </div>
        </div>
      )}
      <label>{c?.connected ? 'Replace token' : 'Personal access token'}</label>
      <SecretInput value={token} onChange={setToken} hint={c?.tokenHint} placeholder="eyJraWQiOi…" />
      <div className="muted conn-help">
        Calendly → <a href="https://calendly.com/integrations/api_webhooks" target="_blank" rel="noreferrer">Integrations → API &amp; Webhooks</a> → Generate new token.
      </div>
      {c?.connected && types.length > 0 && (
        <>
          <label>Default event type for scheduling</label>
          <select value={c.defaultEventTypeUri} onChange={(e) => setDefault(e.target.value)}>
            <option value="">First active event type</option>
            {types.map((t) => (
              <option key={t.uri} value={t.uri}>
                {t.name}
                {t.duration ? ` (${t.duration} min)` : ''}
              </option>
            ))}
          </select>
        </>
      )}
      {c?.connected && (
        <div className="cal-hook">
          <Icon name={ours ? 'check' : 'info'} size={14} />
          {ours ? (
            <span>Live updates on — Calendly notifies this app of bookings and cancellations.</span>
          ) : (
            <span>
              {hooks && !hooks.ok ? hooks.message : 'Get bookings instantly instead of every 30 minutes.'}{' '}
              <button type="button" className="link-btn" onClick={register}>
                Register webhook
              </button>
            </span>
          )}
        </div>
      )}
      {msg && <div className={`test-result ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.text}</div>}
      <div className="conn-actions">
        <button type="button" onClick={connect} disabled={busy || !token.trim()}>
          {busy ? 'Connecting…' : c?.connected ? 'Replace token' : 'Connect Calendly'}
        </button>
        {c?.connected && (
          <>
            <button type="button" className="secondary" onClick={test}>
              Test
            </button>
            {c.source === 'settings' && (
              <button type="button" className="secondary danger-text" onClick={disconnect}>
                Disconnect
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ClaudeCard({ data, reload }) {
  const a = data?.anthropic;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const toast = useToast();
  async function save(body) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.put('/api/integrations/anthropic', body);
      if (body.apiKey) setMsg({ ok: true, text: r.message });
      setKey('');
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    const r = await api.post('/api/integrations/anthropic/test');
    setMsg({ ok: r.ok, text: r.message });
  }
  async function remove() {
    if (!window.confirm('Remove the Claude API key? AI drafting stops until a key is added again.')) return;
    const r = await api.del('/api/integrations/anthropic');
    toast.push(r.stillConnectedViaEnv ? 'Removed — ANTHROPIC_API_KEY in .env is still active' : 'Claude disconnected');
    reload();
  }
  const efforts = [
    { id: 'low', label: 'Fast', hint: 'Quickest drafts' },
    { id: 'medium', label: 'Balanced', hint: 'Recommended' },
    { id: 'high', label: 'Thorough', hint: 'Most careful' },
  ];
  return (
    <div className="card conn-card">
      <div className="conn-head">
        <span className="conn-logo tone-claude">
          <Icon name="sparkles" size={20} />
        </span>
        <div className="conn-title">
          <h3>
            Claude <Status ok={a?.connected} />
            <SourceNote source={a?.source} />
          </h3>
          <div className="muted">
            Drafts replies in your voice with <strong>{a?.modelLabel || 'Claude Opus 5.5'}</strong>, using your knowledge base.
          </div>
        </div>
      </div>
      <label>{a?.connected ? 'Replace API key' : 'Anthropic API key'}</label>
      <SecretInput value={key} onChange={setKey} hint={a?.keyHint} placeholder="sk-ant-…" />
      <div className="muted conn-help">
        Create one at{' '}
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          console.anthropic.com → API keys
        </a>
        . Stored encrypted; never sent to the browser.
      </div>
      <label>Thinking depth</label>
      <div className="seg seg-3">
        {efforts.map((e) => (
          <button type="button" key={e.id} className={a?.effort === e.id ? 'active' : ''} onClick={() => save({ effort: e.id })} disabled={busy} title={e.hint}>
            {e.label}
          </button>
        ))}
      </div>
      {msg && <div className={`test-result ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.text}</div>}
      <div className="conn-actions">
        <button type="button" onClick={() => save({ apiKey: key })} disabled={busy || !key.trim()}>
          {busy ? 'Checking key…' : a?.connected ? 'Replace key' : 'Connect Claude'}
        </button>
        {a?.connected && (
          <>
            <button type="button" className="secondary" onClick={test}>
              Test
            </button>
            {a.source === 'settings' && (
              <button type="button" className="secondary danger-text" onClick={remove}>
                Remove
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResendCard({ data, reload }) {
  const r = data?.resend;
  const [key, setKey] = useState('');
  const [from, setFrom] = useState(r?.from || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => setFrom(r?.from || ''), [r?.from]);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.put('/api/integrations/resend', { apiKey: key || undefined, from });
      setMsg({ ok: true, text: res.message });
      setKey('');
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm('Remove the Resend key? Mailboxes set to send through Resend will fail until you switch them.')) return;
    await api.del('/api/integrations/resend');
    reload();
  }
  return (
    <div className="card conn-card">
      <div className="conn-head">
        <span className="conn-logo tone-dark">
          <Icon name="send" size={19} />
        </span>
        <div className="conn-title">
          <h3>
            Resend <Status ok={r?.connected} />
            <SourceNote source={r?.source} />
          </h3>
          <div className="muted">Optional outgoing provider. Receiving doesn’t need Resend — mail comes in through your mailbox connection.</div>
        </div>
      </div>
      <label>{r?.connected ? 'Replace API key' : 'API key'}</label>
      <SecretInput value={key} onChange={setKey} hint={r?.keyHint} placeholder="re_…" />
      <label>Default from address (optional)</label>
      <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Genius <genius@treasurehill.com>" />
      <div className="muted conn-help">The domain must be verified in Resend. Pick “Resend” as a mailbox’s sending method to use it.</div>
      {msg && <div className={`test-result ${msg.ok ? 'is-ok' : 'is-err'}`}>{msg.text}</div>}
      <div className="conn-actions">
        <button type="button" onClick={save} disabled={busy || (!key.trim() && from === (r?.from || ''))}>
          {busy ? 'Checking…' : r?.connected ? 'Save' : 'Connect Resend'}
        </button>
        {r?.connected && r.source === 'settings' && (
          <button type="button" className="secondary danger-text" onClick={remove}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

export default function Integrations() {
  const [data, setData] = useState(null);
  const [mailboxes, setMailboxes] = useState(null);
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState(null); // chooser | microsoft | imap
  const [highlightMs, setHighlightMs] = useState(0);
  const toast = useToast();

  const reload = useCallback(async () => {
    const [d, m] = await Promise.all([api.get('/api/integrations'), api.get('/api/mail-accounts')]);
    setData(d);
    setMailboxes(m);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // While a mailbox is syncing (or waiting for its first sync), keep its row
  // fresh. A mailbox whose sync failed stops the polling.
  useEffect(() => {
    const busy = mailboxes?.accounts?.some(
      (a) => a.enabled && (a.syncing || a.sync?.state === 'syncing' || (!a.sync?.initialDone && !['error', 'needs_auth'].includes(a.sync?.state)))
    );
    if (!busy) return undefined;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [mailboxes, reload]);

  useEffect(() => {
    const connected = params.get('mailbox_connected');
    const err = params.get('mailbox_error');
    const connect = params.get('connect');
    if (connected) toast.push(`${connected} connected — syncing your mail now`);
    if (err) toast.push(err, { kind: 'err', duration: 9000 });
    if (connect === 'microsoft' || connect === 'imap') setDialog(connect);
    if (connected || err || connect) {
      const next = new URLSearchParams(params);
      ['mailbox_connected', 'mailbox_error', 'connect'].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="integrations-page">
      <div className="page-head">
        <div>
          <h1 style={{ marginBottom: 4 }}>Integrations</h1>
          <div className="muted">Connect your mailboxes, Calendly and Claude. Keys are stored encrypted and never shown again.</div>
        </div>
      </div>
      <div className="conn-grid">
        <MailboxesSection data={data} mailboxes={mailboxes} reload={reload} openConnect={() => setDialog('chooser')} />
        <MicrosoftCard data={data} reload={reload} highlight={highlightMs} />
        <CalendlyCard data={data} reload={reload} />
        <ClaudeCard data={data} reload={reload} />
        <ResendCard data={data} reload={reload} />
      </div>

      <ConnectChooser open={dialog === 'chooser'} onClose={() => setDialog(null)} onPick={setDialog} microsoftReady={data?.microsoft?.configured} />
      <ConnectMicrosoft
        open={dialog === 'microsoft'}
        onClose={() => setDialog(null)}
        microsoft={data?.microsoft}
        onNeedSetup={() => {
          setDialog(null);
          setHighlightMs(Date.now());
        }}
      />
      <ConnectImap
        open={dialog === 'imap'}
        onClose={() => setDialog(null)}
        presets={mailboxes?.presets}
        envSmtp={mailboxes?.envSmtp}
        resendReady={data?.resend?.connected}
        onConnected={(a) => {
          toast.push(`${a.email} connected — syncing your mail now`);
          reload();
        }}
      />
    </div>
  );
}

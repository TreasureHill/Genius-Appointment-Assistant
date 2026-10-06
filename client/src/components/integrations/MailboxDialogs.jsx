import { useEffect, useMemo, useState } from 'react';
import ReactQuill from 'react-quill-new';
import { api } from '../../api';
import Icon from '../ui/Icon.jsx';
import Modal from '../ui/Modal.jsx';

export const ACCOUNT_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#dc2626', '#475569'];

export function MsLogo() {
  return (
    <span className="ms-logo" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

// Step 1 of "Connect mailbox": choose Microsoft 365 or IMAP.
export function ConnectChooser({ open, onClose, onPick, microsoftReady }) {
  return (
    <Modal open={open} onClose={onClose} width={640} icon={<Icon name="inbox" size={18} />} title="Connect a mailbox" subtitle="Mail from every connected mailbox lands in one unified inbox.">
      <div className="connect-options">
        <button type="button" className="connect-opt is-recommended" onClick={() => onPick('microsoft')}>
          <MsLogo />
          <strong>Microsoft 365 / Outlook</strong>
          <span>Work or school mailboxes on Exchange Online — including treasurehill.com. Secure Microsoft sign-in; no password stored.</span>
          <em>{microsoftReady ? 'Recommended' : 'Recommended · one-time setup'}</em>
        </button>
        <button type="button" className="connect-opt" onClick={() => onPick('imap')}>
          <span className="connect-opt-icon">
            <Icon name="mail" size={20} />
          </span>
          <strong>Other email (IMAP)</strong>
          <span>Gmail / Google Workspace, Zoho, Yahoo, iCloud, Fastmail, cPanel hosting, on-prem Exchange.</span>
          <em>Uses an app password</em>
        </button>
      </div>
    </Modal>
  );
}

export function ConnectMicrosoft({ open, onClose, microsoft, onNeedSetup }) {
  const [mailbox, setMailbox] = useState('');
  const [mode, setMode] = useState('delegated');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  useEffect(() => {
    if (open) {
      setError('');
      setBusy(false);
    }
  }, [open]);

  async function go() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'app') {
        await api.post('/api/mail-accounts/microsoft/app', { mailbox });
        window.location.assign('/integrations?mailbox_connected=' + encodeURIComponent(mailbox));
        return;
      }
      const r = await api.post('/api/mail-accounts/microsoft/connect', { mailbox, loginHint: hint, returnTo: '/integrations' });
      window.location.assign(r.url);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      icon={<MsLogo />}
      title="Connect Microsoft 365"
      subtitle="You'll sign in on Microsoft's page and come straight back here."
      footer={
        microsoft?.configured ? (
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="ms-btn" onClick={go} disabled={busy || (mode === 'app' && !/\S+@\S+/.test(mailbox))}>
              <MsLogo /> {busy ? 'Opening Microsoft…' : mode === 'app' ? 'Connect mailbox' : 'Sign in with Microsoft'}
            </button>
          </>
        ) : (
          <button type="button" onClick={onNeedSetup}>
            Set up the Microsoft app registration
          </button>
        )
      }
    >
      {!microsoft?.configured ? (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div>
            Microsoft 365 needs a one-time <strong>app registration</strong> in your Microsoft Entra admin center (about 5 minutes). It lets this app use Microsoft Graph to read and send mail securely —
            Exchange Online no longer accepts IMAP passwords.
          </div>
        </div>
      ) : (
        <>
          <div className="seg" style={{ marginBottom: 6 }}>
            <button type="button" className={mode === 'delegated' ? 'active' : ''} onClick={() => setMode('delegated')}>
              <Icon name="user" size={14} /> Sign in as me
            </button>
            <button type="button" className={mode === 'app' ? 'active' : ''} onClick={() => setMode('app')}>
              <Icon name="shield" size={14} /> Admin-consented app access
            </button>
          </div>
          {mode === 'delegated' ? (
            <>
              <label>Your Microsoft 365 email (optional — pre-fills the sign-in)</label>
              <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="you@treasurehill.com" />
              <label>Shared mailbox to read instead (optional)</label>
              <input value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="genius@treasurehill.com — leave blank for your own inbox" />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Permissions requested: read &amp; write mail, send mail, and offline access (so sync keeps running). If you see “Need admin approval”, ask your IT admin to grant consent for the app.
              </div>
            </>
          ) : (
            <>
              <label>Mailbox address</label>
              <input value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="genius@treasurehill.com" />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                No sign-in: the app reads this mailbox with <em>application</em> permissions (Mail.ReadWrite, Mail.Send) that an admin has granted to the app registration. Ask IT to scope it to this mailbox with
                an application access policy.
              </div>
            </>
          )}
        </>
      )}
      {error && <div className="composer-error">{error}</div>}
    </Modal>
  );
}

const EMPTY_SERVER = { host: '', port: 993, secure: true, user: '', pass: '' };

export function ConnectImap({ open, onClose, presets, envSmtp, resendReady, onConnected }) {
  const [preset, setPreset] = useState('custom');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [imap, setImap] = useState(EMPTY_SERVER);
  const [via, setVia] = useState('smtp');
  const [smtp, setSmtp] = useState({ host: '', port: 465, secure: true });
  const [useEnvLogin, setUseEnvLogin] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Prefill once per opening — the page refreshes its data while syncing, and
  // a new envSmtp object must not wipe what's being typed.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError('');
    // Same login as the SMTP already configured on the server.
    if (envSmtp?.configured && !envSmtp.microsoft) {
      const fromEmail = (String(envSmtp.from).match(/<([^>]+)>/) || [])[1] || (envSmtp.user.includes('@') ? envSmtp.user : '');
      setEmail(fromEmail || '');
      setImap({ ...EMPTY_SERVER, host: envSmtp.guessedImapHost, user: envSmtp.user });
      setUseEnvLogin(true);
      setVia('env_smtp');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = useMemo(() => (presets || []).find((x) => x.id === preset), [presets, preset]);

  function pickPreset(id) {
    setPreset(id);
    const pr = (presets || []).find((x) => x.id === id);
    if (pr) {
      setImap((s) => ({ ...s, host: pr.imap.host || s.host, port: pr.imap.port, secure: pr.imap.secure }));
      setSmtp({ host: pr.smtp.host, port: pr.smtp.port, secure: pr.smtp.secure });
    }
  }

  const imapBody = () => ({ ...imap, user: imap.user || email });

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.post('/api/mail-accounts/imap/test', {
        imap: imapBody(),
        smtp: via === 'smtp' ? { ...smtp, user: imap.user || email, pass: imap.pass } : null,
        useEnvSmtpLogin: useEnvLogin,
      });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, imap: { ok: false, message: e.message } });
    } finally {
      setTesting(false);
    }
  }

  async function connect() {
    setSaving(true);
    setError('');
    try {
      const acct = await api.post('/api/mail-accounts/imap', {
        email,
        displayName,
        imap: imapBody(),
        useEnvSmtpLogin: useEnvLogin,
        outgoing: { via, smtp: via === 'smtp' ? { ...smtp, user: imap.user || email, pass: imap.pass } : undefined },
      });
      onConnected(acct);
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
      width={680}
      icon={<Icon name="mail" size={18} />}
      title="Connect an IMAP mailbox"
      subtitle="Mail is read over IMAP (encrypted). Passwords are stored encrypted and never shown again."
      footer={
        <>
          <button type="button" className="secondary" onClick={test} disabled={testing || !imap.host}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={connect} disabled={saving || !email || !imap.host || (!imap.pass && !useEnvLogin)}>
            {saving ? 'Connecting…' : 'Connect mailbox'}
          </button>
        </>
      }
    >
      {envSmtp?.microsoft && (
        <div className="callout callout-warn">
          <Icon name="alert" size={16} />
          <div>Your .env SMTP is Microsoft 365. Microsoft 365 mailboxes can’t be read over IMAP with a password — use <strong>Connect Microsoft 365</strong> instead.</div>
        </div>
      )}
      <div className="form-grid">
        <label className="span-2">
          Provider
          <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
            {(presets || []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {p?.note && (
          <div className="callout callout-info span-2">
            <Icon name="key" size={15} />
            <div>{p.note}</div>
          </div>
        )}
        <label>
          Email address
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
        <label>
          Your name (shown to recipients)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ali Raza" />
        </label>
        <label>
          IMAP server
          <input value={imap.host} onChange={(e) => setImap({ ...imap, host: e.target.value })} placeholder="imap.example.com" />
        </label>
        <div className="form-inline">
          <label>
            Port
            <input type="number" value={imap.port} onChange={(e) => setImap({ ...imap, port: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={imap.secure} onChange={(e) => setImap({ ...imap, secure: e.target.checked })} /> SSL/TLS
          </label>
        </div>
        <label>
          Username
          <input value={imap.user} onChange={(e) => setImap({ ...imap, user: e.target.value })} placeholder={email || 'Usually your email'} />
        </label>
        <label>
          Password / app password
          <input type="password" value={imap.pass} onChange={(e) => setImap({ ...imap, pass: e.target.value })} placeholder={useEnvLogin ? 'Using the .env SMTP password' : '••••••••'} autoComplete="new-password" />
        </label>
        {envSmtp?.configured && !envSmtp.microsoft && (
          <label className="check span-2">
            <input type="checkbox" checked={useEnvLogin} onChange={(e) => setUseEnvLogin(e.target.checked)} />
            Use the SMTP login already configured on the server ({envSmtp.user || envSmtp.host}) for IMAP too
          </label>
        )}
        <label className="span-2">
          Send replies through
          <select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="smtp">This mailbox’s SMTP server</option>
            {envSmtp?.configured && <option value="env_smtp">The server’s SMTP login ({envSmtp.host})</option>}
            <option value="resend" disabled={!resendReady}>
              Resend{resendReady ? '' : ' (connect Resend first)'}
            </option>
          </select>
        </label>
        {via === 'smtp' && (
          <>
            <label>
              SMTP server
              <input value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.example.com" />
            </label>
            <div className="form-inline">
              <label>
                Port
                <input type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={smtp.secure} onChange={(e) => setSmtp({ ...smtp, secure: e.target.checked })} /> SSL/TLS
              </label>
            </div>
          </>
        )}
      </div>
      {result && (
        <div className={`test-result ${result.ok ? 'is-ok' : 'is-err'}`}>
          {result.microsoft ? (
            <div>
              <Icon name="alert" size={14} /> {result.message}
            </div>
          ) : (
            <>
              <div>
                <Icon name={result.imap?.ok ? 'check' : 'alert'} size={14} /> IMAP — {result.imap?.message}
              </div>
              {result.smtp && (
                <div>
                  <Icon name={result.smtp.ok ? 'check' : 'alert'} size={14} /> {result.smtp.message}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
    </Modal>
  );
}

export function EditMailbox({ open, onClose, account, envSmtp, resendReady, onSaved, onRemoved, onReconnect }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open && account) {
      setForm({
        label: account.label || '',
        displayName: account.displayName || '',
        color: account.color,
        signatureHtml: account.signatureHtml || '',
        enabled: account.enabled,
        isDefault: account.isDefault,
        via: account.outgoing?.via,
        smtp: { host: account.outgoing?.smtp?.host || '', port: account.outgoing?.smtp?.port || 465, secure: account.outgoing?.smtp?.secure !== false, user: account.outgoing?.smtp?.user || '', pass: '' },
      });
      setError('');
    }
  }, [open, account]);
  if (!form || !account) return null;
  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = {
        label: form.label,
        displayName: form.displayName,
        color: form.color,
        signatureHtml: form.signatureHtml,
        enabled: form.enabled,
        isDefault: form.isDefault || undefined,
        outgoing: { via: form.via, smtp: form.via === 'smtp' && form.smtp.host ? form.smtp : undefined },
      };
      const saved = await api.patch(`/api/mail-accounts/${account._id}`, body);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Disconnect ${account.email}? Its synced mail is removed from this app (nothing is deleted from the mailbox itself).`)) return;
    await api.del(`/api/mail-accounts/${account._id}`);
    onRemoved(account);
    onClose();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      icon={account.kind === 'microsoft' ? <MsLogo /> : <Icon name="mail" size={18} />}
      title={account.email}
      subtitle={account.kind === 'microsoft' ? 'Microsoft 365 mailbox' : `IMAP · ${account.imap?.host}`}
      footer={
        <>
          <button type="button" className="danger" onClick={remove}>
            Disconnect
          </button>
          {account.kind === 'microsoft' && account.microsoft?.authMode === 'delegated' && (
            <button type="button" className="secondary" onClick={() => onReconnect(account)}>
              <MsLogo /> Reconnect
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          Label in the inbox
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </label>
        <label>
          Your name (shown to recipients)
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </label>
        <div className="span-2">
          <span className="field-label">Color</span>
          <div className="swatches">
            {ACCOUNT_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch${form.color === c ? ' is-on' : ''}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} aria-label={`Color ${c}`} />
            ))}
          </div>
        </div>
        <label className="span-2">
          Send replies through
          <select value={form.via} onChange={(e) => setForm({ ...form, via: e.target.value })}>
            {account.kind === 'microsoft' && <option value="graph">Microsoft 365 (recommended — saved in Sent Items)</option>}
            <option value="smtp">{account.kind === 'microsoft' ? 'An SMTP server' : 'This mailbox’s SMTP server'}</option>
            {envSmtp?.configured && <option value="env_smtp">The server’s SMTP login ({envSmtp.host})</option>}
            <option value="resend" disabled={!resendReady}>
              Resend{resendReady ? '' : ' (connect Resend first)'}
            </option>
          </select>
        </label>
        {form.via === 'smtp' && (
          <>
            <label>
              SMTP server
              <input value={form.smtp.host} onChange={(e) => setForm({ ...form, smtp: { ...form.smtp, host: e.target.value } })} />
            </label>
            <div className="form-inline">
              <label>
                Port
                <input type="number" value={form.smtp.port} onChange={(e) => setForm({ ...form, smtp: { ...form.smtp, port: Number(e.target.value) } })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.smtp.secure} onChange={(e) => setForm({ ...form, smtp: { ...form.smtp, secure: e.target.checked } })} /> SSL/TLS
              </label>
            </div>
            <label>
              SMTP username
              <input value={form.smtp.user} onChange={(e) => setForm({ ...form, smtp: { ...form.smtp, user: e.target.value } })} />
            </label>
            <label>
              SMTP password {account.outgoing?.smtp?.passSet && <span className="muted">(leave blank to keep)</span>}
              <input type="password" value={form.smtp.pass} onChange={(e) => setForm({ ...form, smtp: { ...form.smtp, pass: e.target.value } })} autoComplete="new-password" />
            </label>
          </>
        )}
        <div className="span-2">
          <span className="field-label">Signature (added below every email you send from this mailbox)</span>
          <div className="sig-editor">
            <ReactQuill theme="snow" value={form.signatureHtml} onChange={(v) => setForm((f) => ({ ...f, signatureHtml: v }))} modules={{ toolbar: [['bold', 'italic'], ['link'], ['clean']] }} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Sync this mailbox
        </label>
        <label className="check">
          <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} disabled={account.isDefault} /> Default for new messages
        </label>
      </div>
      {error && <div className="composer-error">{error}</div>}
    </Modal>
  );
}

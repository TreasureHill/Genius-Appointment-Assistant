import { useState } from 'react';
import { api } from '../../api';
import { SIGNING_MODE_LABEL, fmtMoney } from './bits.jsx';
import { copyText, errText } from './fmt.js';
import { ShieldIcon } from './LotContractCard.jsx';
import './ct-admin.css';

// Settings → alarm monitoring: billing switches, the Stripe connection and
// the DocuSign connection. Secrets live in .env only; GET /api/settings
// reports them as booleans and these cards never ask for them.

function Dot({ ok, label, title }) {
  return (
    <span style={{ marginRight: 12, whiteSpace: 'nowrap' }} title={title}>
      <span className={`badge ${ok ? 'ok' : 'err'}`}>{ok ? 'yes' : 'no'}</span>{' '}
      <span className="muted" style={{ fontSize: 12 }}>
        {label}
      </span>
    </span>
  );
}

function HealthLine({ h }) {
  if (!h || !h.checkedAt) return <span className="muted">not tested yet</span>;
  return (
    <>
      <span className={`badge ${h.ok ? 'ok' : 'err'}`}>{h.ok ? 'ok' : 'error'}</span>{' '}
      <span className="muted" style={{ fontSize: 12 }}>
        {h.message} · {new Date(h.checkedAt).toLocaleString()}
      </span>
    </>
  );
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input readOnly value={value || ''} onFocus={(e) => e.target.select()} className="ct-mono" />
        <button
          type="button"
          className="secondary small"
          onClick={async () => {
            setCopied(await copyText(value || ''));
            setTimeout(() => setCopied(false), 1500);
          }}
          disabled={!value}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'charge.refunded',
];

export function MonitoringBillingCard({ alarm = {}, onSaved }) {
  const [form, setForm] = useState({
    paymentRemindersEnabled: alarm.paymentRemindersEnabled !== false,
    reminderDaysBefore: alarm.reminderDaysBefore ?? 3,
    autoSendInvoices: alarm.autoSendInvoices !== false,
    sendFailedPaymentEmails: alarm.sendFailedPaymentEmails !== false,
    contractsCcEmail: alarm.contractsCcEmail || '',
    defaultSigningMode: alarm.defaultSigningMode || 'remote',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function save() {
    setBusy(true);
    setMsg('');
    try {
      await api.patch('/api/settings/alarm', { ...form, reminderDaysBefore: Number(form.reminderDaysBefore) });
      setMsg('Saved.');
      onSaved && onSaved();
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const check = (key, label, hint) => (
    <div style={{ marginBottom: 6 }}>
      <label className="ct-check" style={{ margin: 0 }}>
        <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} /> {label}
      </label>
      {hint && (
        <div className="muted" style={{ fontSize: 12, marginLeft: 24 }}>
          {hint}
        </div>
      )}
    </div>
  );

  return (
    <div className="card" id="monitoring-billing">
      <div className="ct-head">
        <h2>
          <ShieldIcon /> Alarm monitoring billing
        </h2>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Emails the homeowner gets about their monitoring subscription. Each contract can also turn reminders and receipts off on its
        own; these switches apply to all of them. Welcome, password and cancellation emails always go out.
      </p>
      {check(
        'paymentRemindersEnabled',
        'Upcoming payment reminders',
        'The amount with the HST breakdown, the charge date and the card on file, sent before each monthly charge.'
      )}
      <div className="row" style={{ marginLeft: 24, marginBottom: 8, maxWidth: 420 }}>
        <div>
          <label>Days before the charge (1–14)</label>
          <input
            type="number"
            min={1}
            max={14}
            value={form.reminderDaysBefore}
            disabled={!form.paymentRemindersEnabled}
            onChange={(e) => setForm({ ...form, reminderDaysBefore: e.target.value })}
          />
        </div>
      </div>
      {check('autoSendInvoices', 'Email a receipt after each payment', 'Invoice number, period, subtotal, HST and total, with links to the Stripe invoice and PDF.')}
      {check('sendFailedPaymentEmails', 'Email the homeowner when a payment fails', 'Staff get an internal alert either way.')}

      <div className="row" style={{ marginTop: 8 }}>
        <div>
          <label>Default signing mode for new agreements</label>
          <select value={form.defaultSigningMode} onChange={(e) => setForm({ ...form, defaultSigningMode: e.target.value })}>
            {Object.entries(SIGNING_MODE_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Internal copy (BCC on every contract email)</label>
          <input
            type="email"
            value={form.contractsCcEmail}
            placeholder="contracts@genius.example"
            onChange={(e) => setForm({ ...form, contractsCcEmail: e.target.value })}
          />
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save monitoring settings'}
        </button>
        {msg && <span className={msg.startsWith('Error') ? 'error' : 'success'}>{msg}</span>}
      </div>

      <h3 style={{ marginBottom: 4 }}>Packages</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Set in code and checked against Stripe before every checkout. 13% HST is added on top.
        {alarm.hstRegistrationNumber ? ` HST # ${alarm.hstRegistrationNumber}.` : ' HST registration number not set (HST_REGISTRATION_NUMBER).'}
        {alarm.termsVersion ? ` Agreement terms version ${alarm.termsVersion}.` : ''}
      </div>
      <table className="compact-table" style={{ maxWidth: 560 }}>
        <thead>
          <tr>
            <th>Package</th>
            <th>Monthly</th>
            <th>HST</th>
            <th>Charged</th>
          </tr>
        </thead>
        <tbody>
          {(alarm.packages || []).map((q) => (
            <tr key={q.package}>
              <td>
                <strong>{q.label}</strong>
                {q.desc && (
                  <div className="muted" style={{ fontSize: 11 }}>
                    {q.desc}
                  </div>
                )}
              </td>
              <td>{fmtMoney(q.unitCents)}</td>
              <td>{fmtMoney(q.taxCents)}</td>
              <td>
                <strong>{fmtMoney(q.totalCents)}</strong>/month
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StripeCard({ stripe = {}, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.post('/api/settings/test/stripe', {}));
    } catch (e) {
      setResult({ ok: false, message: errText(e) });
    } finally {
      setBusy(false);
      onSaved && onSaved();
    }
  }

  return (
    <div className="card" id="stripe">
      <div className="ct-head">
        <h2>Payments (Stripe)</h2>
        {stripe.mode === 'test' && <span className="ct-test-mode">TEST MODE</span>}
        {stripe.mode === 'live' && <span className="badge ok">live</span>}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        {stripe.configured ? `Secret key set in .env (${stripe.mode || 'unknown'} mode)` : 'Not configured: set STRIPE_SECRET_KEY in .env'}
        {stripe.apiVersion ? ` · API ${stripe.apiVersion}` : ''}
      </div>
      <div style={{ marginBottom: 10 }}>
        <Dot ok={stripe.configured} label="Secret key" />
        <Dot ok={stripe.webhookSecretSet} label="Webhook secret" />
        <Dot ok={stripe.taxRateSet} label="HST tax rate" title="STRIPE_TAX_RATE_ID — created by npm run stripe:bootstrap" />
        <Dot ok={stripe.catalogOk} label="Prices match" title="Last Test connection found both prices and the 13% exclusive tax rate as the code expects" />
      </div>
      <div>
        Last check: <HealthLine h={stripe.health} />
      </div>
      {result && (
        <div className={result.ok ? 'success' : 'error'} style={{ marginTop: 6 }}>
          {result.message}
          {Array.isArray(result.problems) && result.problems.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {result.problems.map((p, i) => (
                <li key={i}>{typeof p === 'string' ? p : p.message || JSON.stringify(p)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button onClick={test} disabled={busy || !stripe.configured}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      <CopyField label="Webhook endpoint (Stripe Dashboard → Developers → Webhooks)" value={stripe.webhookUrl} />
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>Events to send to the endpoint</summary>
        <div className="ct-mono" style={{ marginTop: 6, lineHeight: 1.7 }}>
          {STRIPE_EVENTS.join(', ')}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          In Stripe also: turn off Stripe’s own receipt and upcoming-renewal emails (this app sends them), set Smart Retries to end in
          “mark the subscription unpaid”, and configure the Customer Portal with cancellation and plan switching off.
        </div>
      </details>
    </div>
  );
}

export function DocuSignCard({ docusign = {}, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.post('/api/settings/test/docusign', {}));
    } catch (e) {
      setResult({ ok: false, message: errText(e), consentUrl: e.data && e.data.consentUrl });
    } finally {
      setBusy(false);
      onSaved && onSaved();
    }
  }

  const consentUrl = (result && result.consentUrl) || docusign.consentUrl;
  const needsConsent = Boolean(result && result.consentUrl);

  return (
    <div className="card" id="docusign">
      <div className="ct-head">
        <h2>Agreements (DocuSign)</h2>
        {docusign.env && <span className={`badge ${docusign.env === 'prod' ? 'ok' : 'pending'}`}>{docusign.env === 'prod' ? 'production' : 'demo'}</span>}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        {docusign.configured ? 'Keys set in .env' : 'Not configured: set DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID and the private key in .env'}
        {docusign.accountId ? ` · account ${docusign.accountId}` : ''}
        {docusign.lastPollAt ? ` · last status check ${new Date(docusign.lastPollAt).toLocaleString()}` : ''}
      </div>
      <div style={{ marginBottom: 10 }}>
        <Dot ok={docusign.integrationKeySet} label="Integration key" />
        <Dot ok={docusign.userIdSet} label="User id" />
        <Dot ok={docusign.privateKeySet} label="Private key" />
        <Dot ok={docusign.connectKeySet} label="Connect HMAC key" />
        <Dot
          ok={docusign.connectEnabled}
          label="Instant updates (Connect)"
          title="Needs a Connect HMAC key and an https APP_URL. Without it the app checks DocuSign every 20 minutes instead."
        />
      </div>
      <div>
        Last check: <HealthLine h={docusign.health} />
      </div>
      {result && (
        <div className={result.ok ? 'success' : 'error'} style={{ marginTop: 6 }}>
          {result.message}
          {result.ok && result.baseUri ? ` (${result.baseUri})` : ''}
        </div>
      )}
      {(needsConsent || (docusign.configured && docusign.health && !docusign.health.ok)) && consentUrl && (
        <div className="card alert alert-warn" style={{ marginTop: 8, padding: '10px 14px' }}>
          <strong>Consent.</strong> DocuSign must be allowed once to act for the sending user. Open the link while signed in to DocuSign
          as that user, click Accept, then Test connection again.{' '}
          <a href={consentUrl} target="_blank" rel="noreferrer">
            Grant consent
          </a>
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={test} disabled={busy || !docusign.configured}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
        {consentUrl && !needsConsent && (
          <a href={consentUrl} target="_blank" rel="noreferrer" className="btn-link">
            Grant consent
          </a>
        )}
      </div>
      <CopyField label="Connect listener URL (used per envelope when Connect is on)" value={docusign.webhookUrl} />
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        In DocuSign Admin → Connect: enable HMAC and add a key (put it in DOCUSIGN_CONNECT_HMAC_KEYS), and allow envelope-level Connect.
        {docusign.redirectUri ? ` Consent redirect URI: ${docusign.redirectUri}.` : ''}
      </div>
    </div>
  );
}

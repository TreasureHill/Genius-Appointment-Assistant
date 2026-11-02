import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { fmtDateTime } from '../../time';
import Tile from '../Tile.jsx';
import ContractSendModal from './ContractSendModal.jsx';
import {
  ContractStatusBadge,
  EnvelopeBadge,
  SignerBadge,
  PACKAGE_LABEL,
  SIGNING_MODE_LABEL,
  downloadFile,
  fmtMoney,
  packageLine,
} from './bits.jsx';
import { EVENT_ACTOR_LABEL, ROLE_LABEL, copyText, errText, fmtDay, fmtDayIn, openAfter, plural, waitText, todayInput } from './fmt.js';
import './ct-admin.css';

// "Alarm monitoring" card on the lot page. What it shows follows the lot's
// closing flag and its current contract (GET /api/lots/:id → `contract`, the
// summary from metrics.contractSummary, with `actions` saying which buttons
// the server will accept):
//   not closed → closing date + Mark closed (& prepare agreement)
//   closed, no contract → Prepare agreement
//   draft → Edit / Preview / Send / Delete
//   sent → per-signer status, Resend / Refresh / Void (+ Sign now in person)
//   declined / voided → reason + Prepare a new agreement
//   package missing → set the package by hand
//   awaiting payment → documents, invite status, Resend invite, payment link
//   active / past due / unpaid → numbers, reminder + invoice toggles
//   cancelled → documents + Prepare a new agreement (restart / new owner)
//   always → last 5 events and a link to the full contract
//
// After an envelope action the card re-reads the lot every 10 s for 3 min
// (status changes arrive from DocuSign Connect / the poller, not from the
// click), then stops; Refresh asks DocuSign directly.
const POLL_MS = 10_000;
const POLL_FOR_MS = 180_000;

export function ShieldIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    </svg>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="ct-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}

export function EventList({ events, tz, limit }) {
  const list = limit ? (events || []).slice(0, limit) : events || [];
  if (!list.length) return <div className="muted" style={{ fontSize: 13 }}>No history yet.</div>;
  return (
    <div className="ct-events">
      {list.map((e) => (
        <div key={e._id} className="timeline-item">
          <div style={{ flex: 1 }}>
            <div className="ct-event-msg">{e.message || e.type.replace(/_/g, ' ')}</div>
            <div className="ct-event-meta">
              {fmtDateTime(e.createdAt, tz)} · {EVENT_ACTOR_LABEL[e.actor] || e.actor}
              {e.actorName ? ` (${e.actorName})` : ''} · {e.type.replace(/_/g, ' ')}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LotContractCard({ lot, contract, alarm, tz, onChanged }) {
  const c = contract;
  const closing = lot.closing || {};
  const [closingDate, setClosingDate] = useState(todayInput());
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [consentUrl, setConsentUrl] = useState('');
  const [modal, setModal] = useState(false);
  const [pkg, setPkg] = useState({ package: '', note: '' });
  const [polling, setPolling] = useState(false);
  const [payLink, setPayLink] = useState('');
  const pollRef = useRef({ timer: null, until: 0 });

  // Stop polling on unmount, and as soon as the envelope leaves "sent".
  useEffect(() => () => clearTimeout(pollRef.current.timer), []);
  useEffect(() => {
    if (polling && c && c.status !== 'sent') stopPolling();
  }, [c && c.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopPolling() {
    clearTimeout(pollRef.current.timer);
    pollRef.current.timer = null;
    setPolling(false);
  }
  function startPolling() {
    clearTimeout(pollRef.current.timer);
    pollRef.current.until = Date.now() + POLL_FOR_MS;
    setPolling(true);
    const tick = async () => {
      try {
        await onChanged();
      } catch {
        /* keep polling */
      }
      if (Date.now() < pollRef.current.until) pollRef.current.timer = setTimeout(tick, POLL_MS);
      else setPolling(false);
    };
    pollRef.current.timer = setTimeout(tick, POLL_MS);
  }

  async function act(kind, fn, okMsg) {
    setBusy(kind);
    setMsg('');
    setConsentUrl('');
    try {
      const r = await fn();
      const text = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      if (text) setMsg(text);
      await onChanged();
      return r;
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
      setConsentUrl((e.data && e.data.consentUrl) || '');
      return null;
    } finally {
      setBusy('');
    }
  }

  const post = (path, body) => api.post(`/api/contracts/${c._id}/${path}`, body || {});

  // --- closing -------------------------------------------------------------
  async function markClosed(prepare) {
    const r = await act('close', () => api.post(`/api/lots/${lot._id}/closing`, { closed: true, closingDate }), 'Lot marked closed.');
    if (r && prepare) setModal(true);
  }
  function reopen() {
    if (!confirm('Reopen this lot? The closing date is cleared.')) return;
    act('reopen', () => api.post(`/api/lots/${lot._id}/closing`, { closed: false }), 'Lot reopened.');
  }

  // --- envelope ------------------------------------------------------------
  function send() {
    act('send', () => post('send'), 'Sent for signature. Status updates appear here automatically.').then((r) => r && startPolling());
  }
  function resend() {
    act('resend', () => post('resend'), 'DocuSign emailed the current signer again.').then((r) => r && startPolling());
  }
  function refresh() {
    act('refresh', () => post('refresh'), (r) => {
      const env = r && r.refresh && r.refresh.envelope;
      const warn = r && r.refresh && r.refresh.warnings && r.refresh.warnings.length ? ` ${r.refresh.warnings.join('; ')}.` : '';
      if (env && env.throttled) return `Checked with DocuSign a moment ago; the next check is allowed in ${waitText(env.retryAfter)}.${warn}`;
      return `Status refreshed.${warn}`;
    });
  }
  function voidIt() {
    const reason = prompt('Reason for voiding (the purchasers see this in DocuSign):');
    if (reason == null) return;
    if (!reason.trim()) return setMsg('Error: A reason is required to void.');
    act('void', () => post('void', { reason: reason.trim() }), 'Envelope voided.');
  }
  function regenerate() {
    act('regenerate', () => post('regenerate'), 'A new draft is ready. Check the details and send it.');
  }
  function del() {
    if (!confirm(`Delete draft ${c.number}?`)) return;
    act('delete', () => api.del(`/api/contracts/${c._id}`), 'Draft deleted.');
  }
  function signNow(recipientId) {
    act('sign', () => post('signing-view', { recipientId }), null).then((r) => {
      // DocuSign brings the signer back to /contracts/:id/signing-return.
      if (r && r.url) window.location.href = r.url;
    });
  }
  function preview() {
    setMsg('');
    openAfter(async () => `/api/contracts/${c._id}/agreement-preview.pdf`).catch((e) => setMsg(`Error: ${errText(e)}`));
  }

  // --- after signing -------------------------------------------------------
  function setPackage(e) {
    e.preventDefault();
    if (!pkg.package) return setMsg('Error: Choose Basic or Smart.');
    if (!pkg.note.trim()) return setMsg('Error: Add a note saying how the package was confirmed.');
    act('package', () => post('set-package', { package: pkg.package, note: pkg.note.trim() }), 'Package set. The welcome email goes out now.').then(
      (r) => r && setPkg({ package: '', note: '' })
    );
  }
  function resendInvite() {
    act('invite', () => post('resend-invite'), (r) => {
      const n = r && r.invite ? r.invite.sent : 0;
      return n ? `Invite sent to ${plural(n, 'purchaser')}.` : 'Invite sent.';
    });
  }
  async function copyPayLink() {
    const r = await act('link', () => post('payment-link'), null);
    if (!r || !r.url) return;
    const ok = await copyText(r.url);
    setPayLink(ok ? '' : r.url);
    setMsg(ok ? 'Payment link copied. It opens the homeowner portal’s payment page (login required).' : 'Copy the payment link below.');
  }
  function toggle(field, enabled) {
    act(field, () => api.patch(`/api/contracts/${c._id}`, { [field]: { enabled } }), null);
  }
  function sendReminder() {
    if (!confirm('Email the purchasers their upcoming payment reminder now?')) return;
    act('reminder', () => post('send-reminder'), 'Reminder sent.');
  }
  async function download(kind, name) {
    setMsg('');
    try {
      await downloadFile(`/api/contracts/${c._id}/documents/${kind}`, name);
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
    }
  }

  // --- render --------------------------------------------------------------
  const modalEl = modal && (
    <ContractSendModal
      lot={lot}
      contract={c && c.status === 'draft' ? c : null}
      alarm={alarm}
      onClose={() => setModal(false)}
      onSaved={(detail, { close, sent } = {}) => {
        // Full reload: the dialog may have saved purchasers / model to the lot.
        onChanged({ full: true });
        if (close) setModal(false);
        if (sent) {
          setMsg(detail && detail.contract && detail.contract.status === 'awaiting_payment' ? 'Signed agreement recorded.' : 'Sent for signature.');
          if (detail && detail.contract && detail.contract.status === 'sent') startPolling();
        } else if (close) setMsg('Draft saved.');
      }}
    />
  );

  const closedLine = closing.closed && (
    <div className="muted" style={{ fontSize: 13 }}>
      Closed {fmtDay(closing.closingDate)}
      {closing.closedBy ? ` · marked by ${closing.closedBy}` : ''}
    </div>
  );

  const message = (msg || consentUrl) && (
    <div className={msg.startsWith('Error') ? 'error' : 'success'} style={{ marginTop: 8 }}>
      {msg}
      {consentUrl && (
        <>
          {' '}
          <a href={consentUrl} target="_blank" rel="noreferrer">
            Grant DocuSign consent
          </a>
          .
        </>
      )}
      {payLink && (
        <input readOnly value={payLink} onFocus={(e) => e.target.select()} style={{ marginTop: 6 }} aria-label="Payment link" />
      )}
    </div>
  );

  let body;
  if (!c) {
    body = !closing.closed ? (
      <>
        <p className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
          When the home closes, mark the lot closed to prepare the purchasers’ alarm monitoring agreement (Basic $24.99 or Smart $32.99
          a month + HST).
        </p>
        <div className="ct-actions">
          <div style={{ minWidth: 170 }}>
            <label htmlFor="ct-closing-date">Closing date</label>
            <input id="ct-closing-date" type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} />
          </div>
          <div style={{ alignSelf: 'flex-end', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="secondary" onClick={() => markClosed(false)} disabled={!!busy || !closingDate}>
              {busy === 'close' ? 'Saving…' : 'Mark closed'}
            </button>
            <button onClick={() => markClosed(true)} disabled={!!busy || !closingDate}>
              Mark closed &amp; prepare agreement
            </button>
          </div>
        </div>
      </>
    ) : (
      <>
        {closedLine}
        <p className="muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
          No monitoring agreement yet.
        </p>
        <div className="ct-actions">
          <button onClick={() => setModal(true)} disabled={!!busy}>
            Prepare agreement
          </button>
          <button className="secondary small" onClick={reopen} disabled={!!busy}>
            Reopen lot
          </button>
        </div>
      </>
    );
  } else {
    const a = c.actions || {};
    const b = c.billing || {};
    const g = c.globals || {};
    const signers = (c.purchasers || []).filter((p) => p.signs !== false);
    const status = c.status;

    const head = (
      <div className="ct-kv">
        <Field label="Agreement">
          <Link to={`/contracts/${c._id}`}>{c.number}</Link>
        </Field>
        <Field label="Signing">{SIGNING_MODE_LABEL[c.signingMode] || c.signingMode}</Field>
        <Field label="Package">{c.package ? packageLine(c.package, c.pricing) : <span className="muted">chosen when signing</span>}</Field>
        {closing.closed && <Field label="Closing">{fmtDay(closing.closingDate)}</Field>}
        {c.signedAt && <Field label="Signed">{fmtDay(c.signedAt)}</Field>}
      </div>
    );

    const signerList = (
      <div>
        {(c.purchasers || []).map((p, i) => (
          <div key={`${p.role}-${i}`} className="ct-signer">
            <span className="ct-step">{i + 1}</span>
            <div style={{ flex: 1, minWidth: 160 }}>
              <strong>{p.name || '—'}</strong> <span className="muted">· {ROLE_LABEL[p.role] || p.role}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {p.email || 'no email'}
                {p.signs === false ? ' · does not sign' : ''}
              </div>
            </div>
            {p.signs !== false && <SignerBadge status={p.signStatus} />}
            {p.signedAt && <span className="muted" style={{ fontSize: 12 }}>{fmtDateTime(p.signedAt, tz)}</span>}
            {status === 'sent' && a.signing_view && p.inPerson && !['signed', 'completed', 'declined'].includes(p.signStatus) && (
              <button className="small" onClick={() => signNow(p.recipientId)} disabled={!!busy}>
                {busy === 'sign' ? 'Opening…' : 'Sign now'}
              </button>
            )}
          </div>
        ))}
      </div>
    );

    if (status === 'draft') {
      body = (
        <>
          {head}
          {signerList}
          <div className="ct-actions">
            {a.edit && (
              <button className="secondary" onClick={() => setModal(true)} disabled={!!busy}>
                {c.signingMode === 'paper' ? 'Edit / upload signed copy' : 'Edit'}
              </button>
            )}
            {c.signingMode !== 'paper' && (
              <button className="secondary" onClick={preview} disabled={!!busy}>
                Preview PDF
              </button>
            )}
            {a.send && (
              <button onClick={send} disabled={!!busy}>
                {busy === 'send' ? 'Sending…' : c.signingMode === 'in_person' ? 'Create for in-person signing' : 'Send for signature'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            {a.delete && (
              <button className="danger small" onClick={del} disabled={!!busy}>
                Delete draft
              </button>
            )}
          </div>
        </>
      );
    } else if (status === 'sent') {
      const e = c.envelope || {};
      body = (
        <>
          {head}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
            DocuSign: <EnvelopeBadge status={e.status} />
            {e.sentAt && <span className="muted">sent {fmtDateTime(e.sentAt, tz)}</span>}
            {e.lastSyncedAt && <span className="muted">· checked {fmtDateTime(e.lastSyncedAt, tz)}</span>}
            {polling && <span className="muted">· watching for updates…</span>}
          </div>
          {signerList}
          <div className="ct-actions">
            {a.resend && !polling && (
              <button className="secondary" onClick={resend} disabled={!!busy}>
                {busy === 'resend' ? 'Resending…' : 'Resend email'}
              </button>
            )}
            <button className="secondary" onClick={refresh} disabled={!!busy}>
              {busy === 'refresh' ? 'Checking…' : 'Refresh status'}
            </button>
            {a.void && !polling && (
              <button className="danger small" onClick={voidIt} disabled={!!busy}>
                Void
              </button>
            )}
          </div>
        </>
      );
    } else if (status === 'declined' || status === 'voided') {
      const e = c.envelope || {};
      const reason = status === 'declined' ? e.declinedReason : e.voidedReason;
      body = (
        <>
          {head}
          <div className="ct-strip">
            <strong>{status === 'declined' ? 'Declined in DocuSign.' : 'Envelope voided.'}</strong>
            {reason ? ` Reason: ${reason}` : ''}
          </div>
          {signerList}
          <div className="ct-actions">
            {a.regenerate && (
              <button onClick={regenerate} disabled={!!busy}>
                {busy === 'regenerate' ? 'Preparing…' : 'Prepare a new agreement'}
              </button>
            )}
            <button className="secondary small" onClick={reopen} disabled={!!busy}>
              Reopen lot
            </button>
          </div>
        </>
      );
    } else {
      // Signed: awaiting payment, billing, or cancelled.
      const docs = c.documents || [];
      const has = (kind) => docs.some((d) => d.kind === kind);
      const portal = c.portal || {};
      const inviteLine = portal.invitedAt
        ? `Invited ${fmtDateTime(portal.invitedAt, tz)}${portal.inviteCount > 1 ? ` (${portal.inviteCount} times)` : ''} · ${
            portal.firstLoginAt ? `first login ${fmtDateTime(portal.firstLoginAt, tz)}` : 'not logged in yet'
          }`
        : 'Portal invite not sent yet';
      const billingLive = ['active', 'past_due', 'unpaid'].includes(status);

      body = (
        <>
          {head}
          {c.needsAttention === 'package_missing' && (
            <form className="ct-strip" onSubmit={setPackage}>
              <strong>Signed without a package.</strong> DocuSign returned no Basic / Smart choice, so payment is on hold. Confirm the
              package with the homeowner, then set it here.
              <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
                <div style={{ maxWidth: 220 }}>
                  <label>Package</label>
                  <select value={pkg.package} onChange={(e) => setPkg({ ...pkg, package: e.target.value })}>
                    <option value="">Choose…</option>
                    {Object.entries(PACKAGE_LABEL).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 2 }}>
                  <label>Note (required)</label>
                  <input value={pkg.note} placeholder="e.g. confirmed Smart by phone with the buyer" onChange={(e) => setPkg({ ...pkg, note: e.target.value })} />
                </div>
                <div style={{ flex: '0 0 auto', minWidth: 0 }}>
                  <button type="submit" disabled={!!busy || !a.set_package}>
                    {busy === 'package' ? 'Saving…' : 'Set package'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {status === 'past_due' || status === 'unpaid' ? (
            <div className="ct-strip">
              <strong>{status === 'unpaid' ? 'Unpaid: Stripe stopped retrying.' : 'Payment failed.'}</strong>{' '}
              {b.lastFailureMessage ? `${b.lastFailureMessage}. ` : ''}
              {b.missedCount ? `${plural(b.missedCount, 'missed payment')}, ${fmtMoney(b.missedOpenCents)} outstanding.` : ''}
              {b.nextPaymentAttempt ? ` Next retry ${fmtDateTime(b.nextPaymentAttempt, tz)}.` : ''}
            </div>
          ) : null}

          {billingLive && (
            <div className="tiles ct-mini">
              <Tile
                label="Next charge"
                value={b.cancelAtPeriodEnd ? 'Ends' : c.nextChargeAt ? fmtDayIn(c.nextChargeAt, tz) : '—'}
                hint={b.cancelAtPeriodEnd ? `cancels ${fmtDayIn(b.currentPeriodEnd, tz)}` : c.pricing ? fmtMoney(c.pricing.totalCents) : undefined}
              />
              <Tile label="Paid" value={fmtMoney(b.totalPaidCents) || '$0.00'} hint={plural(b.paidCount, 'payment')} accent={b.paidCount ? 'ok' : ''} />
              <Tile
                label="Missed"
                value={b.missedCount || 0}
                hint={b.missedCount ? `${fmtMoney(b.missedOpenCents)} open${b.consecutiveMissed > 1 ? ` · ${b.consecutiveMissed} in a row` : ''}` : 'none'}
                accent={b.missedCount ? 'err' : ''}
              />
              <Tile label="Months active" value={c.monthsActive ?? 0} hint={b.startedAt ? `since ${fmtDayIn(b.startedAt, tz)}` : undefined} />
            </div>
          )}

          {status === 'canceled' && (
            <div className="ct-strip">
              <strong>Monitoring cancelled.</strong> To restart it, or for a new owner, prepare a new agreement (edit the purchasers before
              sending).
            </div>
          )}

          {status === 'awaiting_payment' && !c.needsAttention && (
            <div className="ct-strip warn">
              Signed{c.signedAt ? ` ${fmtDay(c.signedAt)}` : ''}; waiting for the homeowner to set up payment in the portal.
            </div>
          )}

          <div className="muted" style={{ fontSize: 13 }}>
            {inviteLine}
          </div>

          <div className="ct-actions">
            {has('agreement_signed') && (
              <button className="secondary small" onClick={() => download('signed', `${c.number}-signed.pdf`)}>
                Signed agreement
              </button>
            )}
            {has('certificate') && (
              <button className="secondary small" onClick={() => download('certificate', `${c.number}-certificate.pdf`)}>
                Certificate
              </button>
            )}
            {a.resend_invite && (
              <button className="secondary small" onClick={resendInvite} disabled={!!busy}>
                {busy === 'invite' ? 'Sending…' : 'Resend invite'}
              </button>
            )}
            {a.payment_link && (
              <button className="secondary small" onClick={copyPayLink} disabled={!!busy}>
                Copy payment link
              </button>
            )}
            {a.send_reminder && (
              <button className="secondary small" onClick={sendReminder} disabled={!!busy}>
                {busy === 'reminder' ? 'Sending…' : 'Send reminder now'}
              </button>
            )}
            {a.regenerate && (
              <button className="small" onClick={regenerate} disabled={!!busy}>
                {busy === 'regenerate' ? 'Preparing…' : 'Prepare a new agreement'}
              </button>
            )}
          </div>

          {(billingLive || status === 'awaiting_payment') && (
            <div className="ct-section">
              <label className="ct-check">
                <input
                  type="checkbox"
                  checked={c.reminders ? c.reminders.enabled !== false : true}
                  disabled={!!busy}
                  onChange={(e) => toggle('reminders', e.target.checked)}
                />
                Payment reminders before each charge
                {g.paymentRemindersEnabled === false && (
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    (global reminders are off in <Link to="/settings">Settings</Link>)
                  </span>
                )}
              </label>
              <label className="ct-check">
                <input
                  type="checkbox"
                  checked={c.invoiceEmails ? c.invoiceEmails.enabled !== false : true}
                  disabled={!!busy}
                  onChange={(e) => toggle('invoiceEmails', e.target.checked)}
                />
                Email a receipt after each payment
                {g.autoSendInvoices === false && (
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    (automatic invoices are off in <Link to="/settings">Settings</Link>)
                  </span>
                )}
              </label>
            </div>
          )}
        </>
      );
    }
  }

  return (
    <div className="card">
      <div className="ct-head">
        <h2>
          <ShieldIcon /> Alarm monitoring
        </h2>
        {c && <ContractStatusBadge status={c.status} />}
        {c && c.needsAttention === 'package_missing' && <span className="badge err">package missing</span>}
        {!c && closing.closed && <span className="badge closed">Closed</span>}
        <div style={{ flex: 1 }} />
        {c && (
          <Link to={`/contracts/${c._id}`} className="btn-link">
            View full contract
          </Link>
        )}
      </div>
      {body}
      {message}
      {c && (
        <div className="ct-section">
          <div className="ct-label" style={{ marginBottom: 4 }}>
            Recent contract activity
          </div>
          <EventList events={c.events} tz={tz} limit={5} />
        </div>
      )}
      {modalEl}
    </div>
  );
}

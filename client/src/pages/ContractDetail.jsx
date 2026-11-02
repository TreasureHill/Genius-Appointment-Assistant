import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useTimezone } from '../timezone.jsx';
import { fmtDateTime } from '../time';
import Tile from '../components/Tile.jsx';
import ContractSendModal from '../components/contracts/ContractSendModal.jsx';
import { EventList, ShieldIcon } from '../components/contracts/LotContractCard.jsx';
import {
  BillingBadge,
  ContractStatusBadge,
  DOCUMENT_KIND_LABEL,
  EnvelopeBadge,
  PACKAGE_LABEL,
  PaymentBadge,
  SIGNING_MODE_LABEL,
  SignerBadge,
  downloadFile,
  fmtMoney,
  packageLine,
} from '../components/contracts/bits.jsx';
import { ROLE_LABEL, copyText, errText, fmtBytes, fmtDay, fmtDayIn, openAfter, plural, waitText } from '../components/contracts/fmt.js';
import '../components/contracts/ct-admin.css';

// One monitoring contract, everything about it: property and purchasers,
// the DocuSign envelope and its actions, stored documents, the Stripe
// subscription mirror, every payment, portal access, history and notes.
// Every action endpoint answers with the same payload as GET /:id, so the
// page simply replaces its state with the answer.

const POLL_MS = 10_000;
const POLL_FOR_MS = 180_000;
const HISTORY_PAGE = 25;

function Field({ label, children }) {
  return (
    <div>
      <div className="ct-label">{label}</div>
      <div>{children || <span className="muted">—</span>}</div>
    </div>
  );
}

function CancelModal({ contract, busy, onCancel, onClose }) {
  // Signed but payment never set up: there is no paid period to run out, so
  // it simply ends now (server: billing.cancelWithoutSubscription).
  const unpaidYet = contract.status === 'awaiting_payment';
  const [atPeriodEnd, setAtPeriodEnd] = useState(!unpaidYet);
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const end = contract.billing && contract.billing.currentPeriodEnd;
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <form
        className="card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onCancel({ atPeriodEnd, reason: reason.trim(), confirm: confirmText.trim() });
        }}
      >
        <div className="ct-head">
          <h2>{unpaidYet ? 'Close out agreement' : 'Cancel monitoring'}</h2>
        </div>
        {unpaidYet ? (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Closes out {contract.number}: it was signed, but payment was never set up. Any open payment page is expired and nothing is
            charged. No email goes to the homeowner. You can prepare a new agreement for the lot afterwards.
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Stops the Stripe subscription for {contract.number}. The homeowner gets a cancellation email. This cannot be undone from here.
          </p>
        )}
        {!unpaidYet && (
          <div className="ct-radio-group" role="radiogroup" aria-label="When">
            <label>
              <input type="radio" checked={atPeriodEnd} onChange={() => setAtPeriodEnd(true)} />
              <span>
                At the end of the paid period{end ? ` (${fmtDay(end)})` : ''}
                <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                  Monitoring continues until then; no further charges.
                </div>
              </span>
            </label>
            <label>
              <input type="radio" checked={!atPeriodEnd} onChange={() => setAtPeriodEnd(false)} />
              <span>
                Immediately
                <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                  Ends the subscription now. Any refund is done in Stripe.
                </div>
              </span>
            </label>
          </div>
        )}
        <label>Reason</label>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. homeowner moved; requested by phone on Nov 3" rows={3} />
        <label>
          Type <span className="kbd">CANCEL</span> to confirm
        </label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        <div className="ct-actions" style={{ marginTop: 12 }}>
          <button type="submit" className="danger" disabled={busy || confirmText.trim() !== 'CANCEL' || !reason.trim()}>
            {busy ? 'Cancelling…' : unpaidYet ? 'Close out agreement' : 'Cancel monitoring'}
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Keep it
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ContractDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { timezone: tz } = useTimezone();
  const [d, setD] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [consentUrl, setConsentUrl] = useState('');
  const [payLink, setPayLink] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [pkg, setPkg] = useState({ package: '', note: '' });
  const [upload, setUpload] = useState({ file: null, note: '' });
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef({ timer: null, until: 0 });
  const fileRef = useRef(null);

  // Unsaved notes survive the reloads that every action triggers.
  const notesDirtyRef = useRef(false);
  notesDirtyRef.current = notesDirty;
  const apply = useCallback((detail) => {
    if (!detail || !detail.contract) return;
    setD(detail);
    setNotes((prev) => (notesDirtyRef.current ? prev : detail.contract.notes || ''));
  }, []);

  const load = useCallback(async () => {
    const detail = await api.get(`/api/contracts/${id}`);
    apply(detail);
    return detail;
  }, [id, apply]);

  useEffect(() => {
    setD(null);
    setLoadErr('');
    load().catch((e) => setLoadErr(errText(e)));
    return () => clearTimeout(pollRef.current.timer);
  }, [load]);

  // Poll while the envelope is out, after a send / resend (updates arrive
  // from DocuSign, not from the click).
  function startPolling() {
    clearTimeout(pollRef.current.timer);
    pollRef.current.until = Date.now() + POLL_FOR_MS;
    setPolling(true);
    const tick = async () => {
      let detail = null;
      try {
        detail = await load();
      } catch {
        /* keep polling */
      }
      const still = !detail || detail.contract.status === 'sent';
      if (still && Date.now() < pollRef.current.until) pollRef.current.timer = setTimeout(tick, POLL_MS);
      else setPolling(false);
    };
    pollRef.current.timer = setTimeout(tick, POLL_MS);
  }

  async function act(kind, fn, okMsg) {
    setBusy(kind);
    setMsg('');
    setConsentUrl('');
    setPayLink('');
    try {
      const r = await fn();
      if (r && r.contract) apply(r);
      const text = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      if (text) setMsg(text);
      return r || {};
    } catch (e) {
      setMsg(`Error: ${errText(e)}`);
      setConsentUrl((e.data && e.data.consentUrl) || '');
      return null;
    } finally {
      setBusy('');
    }
  }
  const post = (path, body) => api.post(`/api/contracts/${id}/${path}`, body || {});

  if (loadErr && !d) {
    return (
      <div>
        <div className="error">{loadErr}</div>
        <Link to="/contracts">← All contracts</Link>
      </div>
    );
  }
  if (!d) return <div className="muted">Loading…</div>;

  const c = d.contract;
  const a = d.actions || {};
  const e = c.envelope || {};
  const b = c.billing || {};
  const p = c.property || {};
  const lot = c.lot && typeof c.lot === 'object' ? c.lot : null;
  const project = c.project && typeof c.project === 'object' ? c.project : null;
  const g = d.globals || {};
  const cfg = d.config || {};
  const billingLive = ['active', 'past_due', 'unpaid'].includes(c.status);
  const signed = ['awaiting_payment', 'active', 'past_due', 'unpaid', 'canceled'].includes(c.status);

  // --- actions -------------------------------------------------------------
  const send = () => act('send', () => post('send'), 'Sent for signature.').then((r) => r && startPolling());
  const resend = () => act('resend', () => post('resend'), 'DocuSign emailed the current signer again.').then((r) => r && startPolling());
  const refresh = () =>
    act('refresh', () => post('refresh'), (r) => {
      const env = r && r.refresh && r.refresh.envelope;
      const warn = r && r.refresh && r.refresh.warnings && r.refresh.warnings.length ? ` ${r.refresh.warnings.join('; ')}.` : '';
      if (env && env.throttled) return `DocuSign was checked a moment ago; next check allowed in ${waitText(env.retryAfter)}.${warn}`;
      return `Refreshed.${warn}`;
    });
  function voidIt() {
    const reason = prompt('Reason for voiding (the purchasers see this in DocuSign):');
    if (reason == null) return;
    if (!reason.trim()) return setMsg('Error: A reason is required to void.');
    act('void', () => post('void', { reason: reason.trim() }), 'Envelope voided.');
  }
  const regenerate = () =>
    act('regenerate', () => post('regenerate'), null).then((r) => {
      if (r && r.contract) navigate(`/contracts/${r.contract._id}`);
    });
  function del() {
    if (!confirm(`Delete draft ${c.number}? This cannot be undone.`)) return;
    act('delete', () => api.del(`/api/contracts/${id}`), null).then((r) => {
      if (!r) return;
      if (r.restored) navigate(`/contracts/${r.restored}`);
      else if (lot) navigate(`/lots/${lot._id}`);
      else navigate('/contracts');
    });
  }
  const signNow = (recipientId) =>
    act('sign', () => post('signing-view', { recipientId }), null).then((r) => {
      if (r && r.url) window.location.href = r.url;
    });
  const preview = () => openAfter(async () => `/api/contracts/${id}/agreement-preview.pdf`).catch((err) => setMsg(`Error: ${errText(err)}`));
  function setPackage(ev) {
    ev.preventDefault();
    if (!pkg.package) return setMsg('Error: Choose Basic or Smart.');
    if (!pkg.note.trim()) return setMsg('Error: Add a note saying how the package was confirmed.');
    act('package', () => post('set-package', { package: pkg.package, note: pkg.note.trim() }), 'Package set. The welcome email goes out now.').then(
      (r) => r && setPkg({ package: '', note: '' })
    );
  }
  const resendInvite = () =>
    act('invite', () => post('resend-invite'), (r) => {
      const n = r && r.invite ? r.invite.sent : 0;
      return n ? `Invite sent to ${plural(n, 'purchaser')}.` : 'Invite sent.';
    });
  async function copyPayLink() {
    const r = await act('link', () => post('payment-link'), null);
    if (!r || !r.url) return;
    const ok = await copyText(r.url);
    setPayLink(ok ? '' : r.url);
    setMsg(ok ? 'Payment link copied. It opens the portal payment page (the homeowner logs in first).' : 'Copy the payment link below.');
  }
  const toggle = (field, enabled) => act(field, () => api.patch(`/api/contracts/${id}`, { [field]: { enabled } }), null);
  function sendReminder() {
    if (!confirm('Email the purchasers their upcoming payment reminder now?')) return;
    act('reminder', () => post('send-reminder'), 'Reminder sent.');
  }
  const syncStripe = () =>
    act('sync', () => post('sync-stripe'), (r) => {
      const fixes = r && r.sync && Array.isArray(r.sync.fixes) ? r.sync.fixes.length : 0;
      return fixes ? `Synced with Stripe: ${plural(fixes, 'correction')}.` : 'Synced with Stripe: everything matched.';
    });
  function cancel(body) {
    if (body.confirm !== 'CANCEL') return;
    const done = c.status === 'awaiting_payment' ? 'Agreement closed out.' : body.atPeriodEnd ? 'Cancellation scheduled for the end of the period.' : 'Monitoring cancelled.';
    act('cancel', () => post('cancel', body), done).then(
      (r) => r && setCancelOpen(false)
    );
  }
  // Fix a purchaser's email / phone after signing. A new email gets its own
  // portal account and welcome email; the old address loses access.
  function updateContact(i) {
    const pu = c.purchasers[i];
    const email = prompt(`Email for ${pu.name || 'this purchaser'} (gets the portal login):`, pu.email || '');
    if (email == null) return;
    const phone = prompt(`Phone for ${pu.name || 'this purchaser'} (optional):`, pu.phone || '');
    if (phone == null) return;
    act('contact', () => post(`purchasers/${i}/contact`, { email: email.trim(), phone: phone.trim() }), (r) => {
      const n = r && r.invite ? r.invite.sent : 0;
      return n ? `Contact updated; welcome email sent to ${plural(n, 'purchaser')}.` : 'Contact updated.';
    });
  }
  function emailPayment(pay) {
    const kind = pay.status === 'paid' ? 'receipt' : 'failure';
    if (!confirm(kind === 'receipt' ? `Email the receipt for ${pay.number || 'this payment'} again?` : 'Email the failed-payment notice again?')) return;
    act(`pay-${pay._id}`, () => post(`payments/${pay._id}/email`, { kind }), kind === 'receipt' ? 'Receipt emailed.' : 'Notice emailed.');
  }
  async function download(doc) {
    setMsg('');
    try {
      await downloadFile(`/api/contracts/${id}/documents/${doc._id}`, doc.filename || `${c.number}-${doc.kind}.pdf`);
    } catch (err) {
      setMsg(`Error: ${errText(err)}`);
    }
  }
  function uploadDoc(ev) {
    ev.preventDefault();
    if (!upload.file) return setMsg('Error: Choose a file to upload.');
    const fd = new FormData();
    fd.append('file', upload.file);
    if (upload.note.trim()) fd.append('note', upload.note.trim());
    act('upload', () => api.upload(`/api/contracts/${id}/documents`, fd), 'Document stored.').then((r) => {
      if (!r) return;
      setUpload({ file: null, note: '' });
      if (fileRef.current) fileRef.current.value = '';
    });
  }
  const saveNotes = () =>
    act('notes', () => api.patch(`/api/contracts/${id}`, { notes }), 'Notes saved.').then((r) => r && setNotesDirty(false));

  // --- render --------------------------------------------------------------
  const stamps = [
    ['Sent', e.sentAt],
    ['Opened', e.deliveredAt],
    ['Completed', e.completedAt],
    ['Declined', e.declinedAt],
    ['Voided', e.voidedAt],
  ].filter(([, at]) => at);
  const events = d.events || [];
  const payments = d.payments || [];
  const documents = d.documents || [];

  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/contracts" className="muted" style={{ fontSize: 13 }}>
            ← All contracts
          </Link>
          <h1 style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <ShieldIcon size={22} /> {c.number} <ContractStatusBadge status={c.status} />
            {c.needsAttention === 'package_missing' && <span className="badge err">package missing</span>}
            {!c.isCurrent && <span className="badge completed">replaced</span>}
            {cfg.stripeMode === 'test' && <span className="ct-test-mode">TEST MODE</span>}
          </h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {p.projectName || project?.name || ''}
            {lot ? (
              <>
                {' · '}
                <Link to={`/lots/${lot._id}`}>Lot {lot.lotNumber}</Link>
              </>
            ) : p.lotNumber ? (
              ` · Lot ${p.lotNumber}`
            ) : (
              ''
            )}
            {p.address ? ` · ${p.address}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(a.refresh || b.customerId) && (
            <button className="secondary" onClick={refresh} disabled={!!busy} title="Ask DocuSign (and Stripe) for the latest now">
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {(msg || consentUrl) && (
        <div className={`card alert ${msg.startsWith('Error') ? 'alert-err' : 'alert-ok'}`} style={{ padding: '10px 16px' }}>
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
          {payLink && <input readOnly value={payLink} onFocus={(ev) => ev.target.select()} style={{ marginTop: 6 }} aria-label="Payment link" />}
        </div>
      )}

      {c.needsAttention === 'package_missing' && (
        <form className="card alert alert-err" onSubmit={setPackage}>
          <strong>Signed without a monitoring package.</strong> DocuSign returned no Basic / Smart choice, so payment is on hold. Confirm
          the package with the homeowner, then set it here; the welcome email goes out right after.
          <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
            <div style={{ maxWidth: 240 }}>
              <label>Package</label>
              <select value={pkg.package} onChange={(ev) => setPkg({ ...pkg, package: ev.target.value })}>
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
              <input value={pkg.note} onChange={(ev) => setPkg({ ...pkg, note: ev.target.value })} placeholder="How the choice was confirmed" />
            </div>
            <div style={{ flex: '0 0 auto', minWidth: 0 }}>
              <button type="submit" disabled={!!busy || !a.set_package}>
                {busy === 'package' ? 'Saving…' : 'Set package'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Summary */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Summary</h2>
        <div className="ct-kv">
          <Field label="Package">{c.package ? packageLine(c.package, c.pricing) : <span className="muted">not chosen yet</span>}</Field>
          <Field label="Model">{p.model}</Field>
          <Field label="Closing">{fmtDay(p.closingDate)}</Field>
          <Field label="Signing">{SIGNING_MODE_LABEL[c.signingMode] || c.signingMode}</Field>
          <Field label="Signed">{fmtDay(c.signedAt)}</Field>
          <Field label="Terms version">{c.termsVersion}</Field>
          <Field label="Created">
            {fmtDateTime(c.createdAt, tz)}
            {c.createdBy ? ` by ${c.createdBy}` : ''}
          </Field>
        </div>
        <h3 style={{ marginBottom: 2 }}>Purchasers</h3>
        {(c.purchasers || []).map((pu, i) => (
          <div key={`${pu.role}-${i}`} className="ct-signer">
            <span className="ct-step">{i + 1}</span>
            <div style={{ flex: 1, minWidth: 180 }}>
              <strong>{pu.name || '—'}</strong> <span className="muted">· {ROLE_LABEL[pu.role] || pu.role}</span>
              <div className="muted" style={{ fontSize: 12 }}>
                {[pu.email, pu.phone].filter(Boolean).join(' · ') || 'no contact'}
                {pu.signs === false ? ' · does not sign' : ''}
              </div>
            </div>
            {pu.signs !== false && <SignerBadge status={pu.signStatus} />}
            {pu.signedAt && <span className="muted" style={{ fontSize: 12 }}>signed {fmtDateTime(pu.signedAt, tz)}</span>}
            {pu.declinedReason && <span className="error" style={{ margin: 0 }}>{pu.declinedReason}</span>}
            {c.status === 'sent' && a.signing_view && pu.clientUserId && !['signed', 'completed', 'declined'].includes(pu.signStatus) && (
              <button className="small" onClick={() => signNow(pu.recipientId)} disabled={!!busy}>
                Sign now
              </button>
            )}
            {a.update_contact && (
              <button className="secondary small" onClick={() => updateContact(i)} disabled={!!busy}>
                {pu.email ? 'Update contact' : 'Add email'}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Envelope */}
      <div className="card">
        <div className="ct-head">
          <h2>Agreement</h2>
          {e.status ? <EnvelopeBadge status={e.status} /> : <span className="badge pending">not sent</span>}
          {polling && <span className="muted" style={{ fontSize: 12 }}>watching for DocuSign updates…</span>}
        </div>
        {c.signingMode === 'paper' && c.status !== 'draft' ? (
          <div className="muted" style={{ fontSize: 13 }}>Signed on paper; the signed copy was uploaded (see Documents).</div>
        ) : (
          <div className="ct-kv">
            <Field label="Envelope">{e.id ? <span className="ct-mono">{e.id}</span> : null}</Field>
            {stamps.map(([label, at]) => (
              <Field key={label} label={label}>
                {fmtDateTime(at, tz)}
              </Field>
            ))}
            {e.lastConnectAt && <Field label="Last DocuSign update">{fmtDateTime(e.lastConnectAt, tz)}</Field>}
            {e.lastSyncedAt && <Field label="Last checked">{fmtDateTime(e.lastSyncedAt, tz)}</Field>}
          </div>
        )}
        {(e.declinedReason || e.voidedReason) && (
          <div className="ct-strip">
            {e.declinedReason ? `Declined: ${e.declinedReason}` : `Voided: ${e.voidedReason}`}
          </div>
        )}
        {c.status === 'sent' && !cfg.docusignConnect && (
          <div className="muted" style={{ fontSize: 12 }}>
            Instant DocuSign updates (Connect) are off, so status is checked every 20 minutes. Use Refresh to check now.
          </div>
        )}
        <div className="ct-actions">
          {a.edit && (
            <button className="secondary" onClick={() => setEditOpen(true)} disabled={!!busy}>
              {c.signingMode === 'paper' ? 'Edit / upload signed copy' : 'Edit draft'}
            </button>
          )}
          {c.status === 'draft' && c.signingMode !== 'paper' && (
            <button className="secondary" onClick={preview} disabled={!!busy}>
              Preview PDF
            </button>
          )}
          {a.send && (
            <button onClick={send} disabled={!!busy || !cfg.docusign} title={cfg.docusign ? '' : 'DocuSign is not configured (Settings)'}>
              {busy === 'send' ? 'Sending…' : c.signingMode === 'in_person' ? 'Create for in-person signing' : 'Send for signature'}
            </button>
          )}
          {a.resend && (
            <button className="secondary" onClick={resend} disabled={!!busy || polling}>
              Resend email
            </button>
          )}
          {a.void && (
            <button className="danger small" onClick={voidIt} disabled={!!busy}>
              Void
            </button>
          )}
          {a.regenerate && c.isCurrent && (
            <button onClick={regenerate} disabled={!!busy}>
              {busy === 'regenerate' ? 'Preparing…' : 'Prepare a new agreement'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {a.delete && (
            <button className="danger small" onClick={del} disabled={!!busy}>
              Delete draft
            </button>
          )}
        </div>
        {(c.previousEnvelopes || []).length > 0 && (
          <div className="ct-section">
            <div className="ct-label">Earlier envelopes</div>
            {c.previousEnvelopes.map((pe) => (
              <div key={pe.id} style={{ fontSize: 12 }}>
                <span className="ct-mono">{pe.id}</span> · {pe.status}
                {pe.reason ? ` · ${pe.reason}` : ''}
                {pe.at ? ` · ${fmtDateTime(pe.at, tz)}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Documents */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Documents</h2>
        {documents.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>
            Nothing stored yet. The unsigned agreement is stored when it is sent; the signed copy and certificate when signing completes.
          </div>
        ) : (
          <div className="ct-table-wrap">
            <table className="compact-table" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Source</th>
                  <th>Size</th>
                  <th title="SHA-256 fingerprint of the stored file">SHA-256</th>
                  <th>Stored</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc._id}>
                    <td>
                      <strong>{DOCUMENT_KIND_LABEL[doc.kind] || doc.kind}</strong>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {doc.filename}
                        {doc.note ? ` · ${doc.note}` : ''}
                      </div>
                    </td>
                    <td>{doc.source === 'docusign' ? 'DocuSign' : doc.source === 'upload' ? `Upload${doc.uploadedBy ? ` (${doc.uploadedBy})` : ''}` : 'Generated'}</td>
                    <td className="nowrap">{fmtBytes(doc.size)}</td>
                    <td>
                      <span className="ct-mono" title={doc.sha256}>
                        {(doc.sha256 || '').slice(0, 12)}
                      </span>
                    </td>
                    <td className="nowrap">{fmtDateTime(doc.createdAt, tz)}</td>
                    <td>
                      <button className="secondary small" onClick={() => download(doc)}>
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form className="ct-section row" onSubmit={uploadDoc} style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 2 }}>
            <label>Add a document (PDF, PNG or JPEG, up to 15 MB)</label>
            <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg" onChange={(ev) => setUpload({ ...upload, file: ev.target.files[0] || null })} />
          </div>
          <div style={{ flex: 2 }}>
            <label>Note</label>
            <input value={upload.note} onChange={(ev) => setUpload({ ...upload, note: ev.target.value })} placeholder="e.g. amendment signed Nov 10" />
          </div>
          <div style={{ flex: '0 0 auto', minWidth: 0 }}>
            <button type="submit" className="secondary" disabled={!!busy || !upload.file}>
              {busy === 'upload' ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </form>
      </div>

      {/* Billing */}
      {signed && (
        <div className="card">
          <div className="ct-head">
            <h2>Billing</h2>
            <BillingBadge status={b.status || 'none'} />
            {b.cancelAtPeriodEnd && <span className="badge contacted">ends {fmtDayIn(b.currentPeriodEnd, tz)}</span>}
            <div style={{ flex: 1 }} />
            {d.links?.stripeCustomer && (
              <a className="btn-link" href={d.links.stripeCustomer} target="_blank" rel="noreferrer">
                Stripe customer ↗
              </a>
            )}
            {d.links?.stripeSubscription && (
              <a className="btn-link" href={d.links.stripeSubscription} target="_blank" rel="noreferrer">
                Subscription ↗
              </a>
            )}
          </div>
          {(c.status === 'past_due' || c.status === 'unpaid') && (
            <div className="ct-strip">
              <strong>{c.status === 'unpaid' ? 'Unpaid: Stripe stopped retrying.' : 'Payment failed.'}</strong>
              {b.lastFailureMessage ? ` ${b.lastFailureMessage}.` : ''}
              {b.lastFailureAt ? ` Last failure ${fmtDateTime(b.lastFailureAt, tz)}.` : ''}
            </div>
          )}
          <div className="tiles ct-mini">
            <Tile
              label="Next charge"
              value={b.cancelAtPeriodEnd ? 'None' : d.nextChargeAt ? fmtDayIn(d.nextChargeAt, tz) : '—'}
              hint={!b.cancelAtPeriodEnd && c.pricing ? fmtMoney(c.pricing.totalCents) : undefined}
            />
            <Tile label="Paid" value={fmtMoney(b.totalPaidCents) || '$0.00'} hint={`${plural(b.paidCount || 0, 'payment')}${b.totalTaxCents ? ` · ${fmtMoney(b.totalTaxCents)} HST` : ''}`} accent={b.paidCount ? 'ok' : ''} />
            <Tile
              label="Missed"
              value={b.missedCount || 0}
              hint={b.missedCount ? `${fmtMoney(b.missedOpenCents)} open${b.consecutiveMissed ? ` · ${b.consecutiveMissed} in a row` : ''}` : 'none'}
              accent={b.missedCount ? 'err' : ''}
            />
            <Tile label="Failed attempts" value={b.failedCount || 0} />
            <Tile label="Months active" value={d.monthsActive ?? 0} hint={b.startedAt ? `since ${fmtDayIn(b.startedAt, tz)}` : c.signedAt ? `signed ${fmtDay(c.signedAt)}` : undefined} />
          </div>
          <div className="ct-kv">
            <Field label="Card">
              {b.pmLast4 ? `${(b.pmBrand || 'card').toUpperCase()} ending ${b.pmLast4}${b.pmExpMonth ? ` · exp ${String(b.pmExpMonth).padStart(2, '0')}/${b.pmExpYear}` : ''}` : null}
            </Field>
            <Field label="Current period">
              {b.currentPeriodStart ? `${fmtDayIn(b.currentPeriodStart, tz)} – ${fmtDayIn(b.currentPeriodEnd, tz)}` : null}
            </Field>
            <Field label="First paid">{fmtDayIn(b.firstPaidAt, tz)}</Field>
            <Field label="Last paid">{fmtDayIn(b.lastPaidAt, tz)}</Field>
            {b.canceledAt && <Field label="Cancelled">{fmtDateTime(b.canceledAt, tz)}{c.canceledBy ? ` by ${c.canceledBy}` : ''}</Field>}
            {c.cancelReason && <Field label="Cancel reason">{c.cancelReason}</Field>}
            {b.status === 'checkout_open' && <Field label="Checkout">open until {fmtDateTime(b.checkoutExpiresAt, tz)}</Field>}
            {b.lastReconciledAt && <Field label="Last synced">{fmtDateTime(b.lastReconciledAt, tz)}</Field>}
            <Field label="Customer">{b.customerId ? <span className="ct-mono">{b.customerId}</span> : null}</Field>
            <Field label="Subscription">{b.subscriptionId ? <span className="ct-mono">{b.subscriptionId}</span> : null}</Field>
          </div>
          <div className="ct-section">
            <label className="ct-check">
              <input type="checkbox" checked={!(c.reminders && c.reminders.enabled === false)} disabled={!!busy} onChange={(ev) => toggle('reminders', ev.target.checked)} />
              Payment reminders before each charge
              {c.reminders?.lastRemindedAt && (
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  last sent {fmtDateTime(c.reminders.lastRemindedAt, tz)}
                </span>
              )}
              {g.paymentRemindersEnabled === false && (
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  (global reminders are off in <Link to="/settings#monitoring-billing">Settings</Link>)
                </span>
              )}
            </label>
            <label className="ct-check">
              <input type="checkbox" checked={!(c.invoiceEmails && c.invoiceEmails.enabled === false)} disabled={!!busy} onChange={(ev) => toggle('invoiceEmails', ev.target.checked)} />
              Email a receipt after each payment
              {g.autoSendInvoices === false && (
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                  (automatic invoices are off in <Link to="/settings#monitoring-billing">Settings</Link>)
                </span>
              )}
            </label>
          </div>
          <div className="ct-actions">
            {a.sync_stripe && (
              <button className="secondary" onClick={syncStripe} disabled={!!busy || !cfg.stripe}>
                {busy === 'sync' ? 'Syncing…' : 'Sync with Stripe'}
              </button>
            )}
            {a.send_reminder && (
              <button className="secondary" onClick={sendReminder} disabled={!!busy}>
                {busy === 'reminder' ? 'Sending…' : 'Send reminder now'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            {a.cancel && (
              <button className="danger" onClick={() => setCancelOpen(true)} disabled={!!busy}>
                {c.status === 'awaiting_payment' ? 'Close out agreement' : 'Cancel monitoring'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Payments */}
      {signed && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Payments</h2>
          {payments.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No invoices yet.
            </div>
          ) : (
            <div className="ct-table-wrap">
              <table className="compact-table" style={{ minWidth: 900 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice</th>
                    <th>Period</th>
                    <th>Subtotal</th>
                    <th>HST</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Links</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((pay) => (
                    <tr key={pay._id}>
                      <td className="nowrap">{fmtDayIn(pay.paidAt || pay.invoiceCreatedAt, tz)}</td>
                      <td className="ct-mono">{pay.number || '—'}</td>
                      <td className="nowrap">
                        {pay.periodStart ? `${fmtDayIn(pay.periodStart, tz)} – ${fmtDayIn(pay.periodEnd, tz)}` : '—'}
                      </td>
                      <td>{fmtMoney(pay.subtotalCents)}</td>
                      <td>{fmtMoney(pay.taxCents)}</td>
                      <td className="nowrap">
                        <strong>{fmtMoney(pay.totalCents)}</strong>
                        {pay.amountRefundedCents > 0 && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {fmtMoney(pay.amountRefundedCents)} refunded
                          </div>
                        )}
                        {pay.status === 'open' && pay.amountRemainingCents > 0 && (
                          <div className="error" style={{ fontSize: 11, margin: 0 }}>
                            {fmtMoney(pay.amountRemainingCents)} due
                          </div>
                        )}
                      </td>
                      <td>
                        <PaymentBadge status={pay.status} />
                        {pay.missed && (
                          <div>
                            <span className="badge err" style={{ marginTop: 3 }}>
                              missed
                            </span>
                          </div>
                        )}
                        {pay.amountMismatch && (
                          <div className="error" style={{ fontSize: 11, margin: 0 }} title="The amount Stripe charged differs from the package price">
                            amount differs
                          </div>
                        )}
                        {pay.failureMessage && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {pay.failureMessage}
                          </div>
                        )}
                      </td>
                      <td>
                        {pay.attemptCount || 0}
                        {pay.nextPaymentAttempt && pay.status === 'open' && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            next {fmtDateTime(pay.nextPaymentAttempt, tz)}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        {pay.hostedInvoiceUrl && (
                          <a href={pay.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                            Invoice ↗
                          </a>
                        )}
                        {pay.hostedInvoiceUrl && pay.invoicePdfUrl ? ' · ' : ''}
                        {pay.invoicePdfUrl && (
                          <a href={pay.invoicePdfUrl} target="_blank" rel="noreferrer">
                            PDF ↗
                          </a>
                        )}
                      </td>
                      <td className="nowrap">
                        {(pay.status === 'paid' || pay.status === 'open') && (
                          <button className="secondary small" onClick={() => emailPayment(pay)} disabled={!!busy}>
                            {busy === `pay-${pay._id}` ? 'Sending…' : pay.status === 'paid' ? 'Email receipt' : 'Email notice'}
                          </button>
                        )}
                        {pay.receiptEmail?.sentAt && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            receipt sent {fmtDateTime(pay.receiptEmail.sentAt, tz)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Portal access */}
      {signed && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Homeowner portal</h2>
          <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
            {c.portal?.invitedAt
              ? `Invited ${fmtDateTime(c.portal.invitedAt, tz)}${c.portal.inviteCount > 1 ? ` (${c.portal.inviteCount} times)` : ''}. ${
                  c.portal.firstLoginAt ? `First login ${fmtDateTime(c.portal.firstLoginAt, tz)}.` : 'Nobody has logged in yet.'
                }`
              : c.needsAttention
                ? 'The invite goes out once the package is set.'
                : 'No invite sent yet.'}
          </div>
          {(d.portalUsers || []).map((u) => (
            <div key={u._id} className="ct-signer">
              <div style={{ flex: 1, minWidth: 200 }}>
                <strong>{u.email}</strong>
                {u.name ? <span className="muted"> · {u.name}</span> : null}
              </div>
              {u.disabled ? (
                <span className="badge err">disabled</span>
              ) : u.locked ? (
                <span className="badge err">locked</span>
              ) : u.hasPassword ? (
                <span className="badge ok">password set</span>
              ) : u.invitePending ? (
                <span className="badge contacted">invite pending</span>
              ) : (
                <span className="badge pending">invite expired</span>
              )}
              <span className="muted" style={{ fontSize: 12 }}>
                {u.lastLoginAt ? `last login ${fmtDateTime(u.lastLoginAt, tz)}` : 'never logged in'}
                {!u.hasPassword && u.inviteExpiresAt ? ` · link ${u.invitePending ? 'expires' : 'expired'} ${fmtDateTime(u.inviteExpiresAt, tz)}` : ''}
              </span>
            </div>
          ))}
          <div className="ct-actions">
            {a.resend_invite && (
              <button className="secondary" onClick={resendInvite} disabled={!!busy}>
                {busy === 'invite' ? 'Sending…' : 'Resend invite'}
              </button>
            )}
            {a.payment_link && (
              <button className="secondary" onClick={copyPayLink} disabled={!!busy}>
                Copy payment link
              </button>
            )}
          </div>
        </div>
      )}

      {/* Notes */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Notes</h2>
        <textarea
          value={notes}
          rows={4}
          onChange={(ev) => {
            setNotes(ev.target.value);
            setNotesDirty(true);
          }}
          placeholder="Internal notes (not shown to the homeowner)"
        />
        <div className="ct-actions">
          <button onClick={saveNotes} disabled={!!busy || !notesDirty}>
            {busy === 'notes' ? 'Saving…' : 'Save notes'}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>History</h2>
        <EventList events={events.slice(0, historyShown)} tz={tz} />
        {events.length > historyShown && (
          <button className="secondary small" style={{ marginTop: 8 }} onClick={() => setHistoryShown((n) => n + HISTORY_PAGE)}>
            Show more ({events.length - historyShown} older)
          </button>
        )}
        {(d.history || []).length > 0 && (
          <div className="ct-section">
            <div className="ct-label">Other agreements for this lot</div>
            {d.history.map((h) => (
              <div key={h._id} style={{ fontSize: 13, padding: '3px 0' }}>
                <Link to={`/contracts/${h._id}`}>{h.number}</Link> <ContractStatusBadge status={h.status} />{' '}
                <span className="muted">
                  {h.isCurrent ? 'current · ' : ''}
                  created {fmtDateTime(h.createdAt, tz)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {editOpen && (
        <ContractSendModal
          lot={lot ? { ...lot, project: project || undefined } : null}
          contract={c}
          onClose={() => setEditOpen(false)}
          onSaved={(detail, { close, sent } = {}) => {
            if (detail && detail.contract) apply(detail);
            else load().catch(() => {});
            if (close) setEditOpen(false);
            if (sent) {
              setMsg(detail?.contract?.status === 'sent' ? 'Sent for signature.' : 'Signed agreement recorded.');
              if (detail?.contract?.status === 'sent') startPolling();
            } else if (close) setMsg('Draft saved.');
          }}
        />
      )}
      {cancelOpen && <CancelModal contract={c} busy={busy === 'cancel'} onCancel={cancel} onClose={() => setCancelOpen(false)} />}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ContractStatusBadge, SignerBadge } from '../components/contracts/bits.jsx';
import { ROLE_LABEL, errText } from '../components/contracts/fmt.js';
import '../components/contracts/ct-admin.css';

// DocuSign sends the in-person signer back here
// (?recipientId=…&event=signing_complete|cancel|decline|…). The event is
// display-only — anyone can type it into the URL — so the real status comes
// from the server (refresh, then a few re-reads while DocuSign catches up).
// From here staff hand the tablet to the next purchaser. Rendered outside the
// admin Layout (App.jsx): a purchaser may be holding the device, so leaving
// this page for the admin app takes an explicit staff confirmation.

const EVENT_TEXT = {
  signing_complete: { tone: 'ok', title: 'Signed', text: 'Thank you. DocuSign has the signature.' },
  viewing_complete: { tone: 'ok', title: 'Viewed', text: 'The agreement was viewed.' },
  cancel: { tone: 'warn', title: 'Not signed yet', text: 'Signing was paused. The purchaser can sign later from here.' },
  decline: { tone: 'err', title: 'Declined', text: 'The purchaser declined to sign. The agreement is now void; prepare a new one from the contract page if needed.' },
  session_timeout: { tone: 'warn', title: 'Session timed out', text: 'The signing session expired. Open it again with Sign now.' },
  ttl_expired: { tone: 'warn', title: 'Link expired', text: 'The signing link expired. Open it again with Sign now.' },
  exception: { tone: 'err', title: 'DocuSign error', text: 'DocuSign reported an error. Try Sign now again, or send by email instead.' },
  id_check_failed: { tone: 'err', title: 'ID check failed', text: 'DocuSign could not verify the signer.' },
};
const POLL_MS = 5_000;
const POLLS = 12;

export default function ContractSigningReturn() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const event = params.get('event') || '';
  const justSigned = event === 'signing_complete' ? params.get('recipientId') || '' : '';
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    let live = true;
    let n = 0;
    async function tick() {
      try {
        // In-person envelopes still out for signature get a short server-side
        // refresh throttle, so each poll asks DocuSign directly; a refused
        // refresh (e.g. DocuSign down) falls back to a plain re-read.
        const detail = await api
          .post(`/api/contracts/${id}/refresh`, {})
          .catch(() => api.get(`/api/contracts/${id}`));
        if (!live) return;
        setD(detail);
        const done = detail.contract.status !== 'sent';
        if (!done && ++n < POLLS) timer.current = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (live) setErr(errText(e));
      }
    }
    tick();
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, [id]);

  async function signNow(recipientId) {
    setBusy(recipientId);
    setErr('');
    try {
      const r = await api.post(`/api/contracts/${id}/signing-view`, { recipientId });
      if (r && r.url) window.location.href = r.url;
    } catch (e) {
      setErr(e.message === 'not_your_turn' ? 'DocuSign says it is not this purchaser’s turn yet. Wait a moment and try again.' : errText(e));
    } finally {
      setBusy('');
    }
  }

  // Way out to the admin app, behind a confirmation the purchaser would have
  // no reason to accept.
  function staffGo(e) {
    if (!window.confirm('Staff only: take the device back from the purchaser before continuing. Continue to the admin app?')) {
      e.preventDefault();
    }
  }

  const ev = EVENT_TEXT[event] || (event ? { tone: 'warn', title: 'Back from DocuSign', text: `DocuSign returned “${event}”.` } : null);
  const c = d && d.contract;
  const waiting = c
    ? (c.purchasers || []).filter(
        (p) => p.signs !== false && p.clientUserId && p.recipientId !== justSigned && !['signed', 'completed', 'declined'].includes(p.signStatus)
      )
    : [];

  return (
    <div>
      <h1 style={{ marginBottom: 6 }}>In-person signing</h1>
      {ev && (
        <div className={`card alert alert-${ev.tone}`} style={{ padding: '12px 16px' }}>
          <strong>{ev.title}.</strong> {ev.text}
        </div>
      )}
      {err && <div className="error">{err}</div>}
      {!c ? (
        !err && <div className="muted">Checking with DocuSign…</div>
      ) : (
        <div className="card">
          <div className="ct-head">
            <h2>{c.number}</h2>
            <ContractStatusBadge status={c.status} />
          </div>
          {(c.purchasers || []).map((p, i) => (
            <div key={`${p.role}-${i}`} className="ct-signer">
              <span className="ct-step">{i + 1}</span>
              <div style={{ flex: 1, minWidth: 160 }}>
                <strong>{p.name}</strong> <span className="muted">· {ROLE_LABEL[p.role] || p.role}</span>
              </div>
              {p.signs !== false && <SignerBadge status={p.recipientId === justSigned && !['signed', 'completed'].includes(p.signStatus) ? 'signed' : p.signStatus} />}
            </div>
          ))}
          {c.status === 'sent' && waiting.length > 0 && (
            <div className="ct-section">
              <p style={{ marginTop: 0 }}>
                Hand the device to <strong>{waiting[0].name}</strong>, then:
              </p>
              <div className="ct-actions">
                {waiting.map((p, i) => (
                  <button key={p.recipientId} className={i === 0 ? '' : 'secondary'} onClick={() => signNow(p.recipientId)} disabled={!!busy}>
                    {busy === p.recipientId ? 'Opening…' : `Sign now: ${p.name}`}
                  </button>
                ))}
              </div>
            </div>
          )}
          {c.status === 'sent' && waiting.length === 0 && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Waiting for DocuSign to confirm the last signature…
            </p>
          )}
          {c.status === 'awaiting_payment' && (
            <p style={{ marginBottom: 0 }}>
              All signatures are in. The homeowner gets an email to set their portal password and set up payment.
            </p>
          )}
        </div>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Staff:{' '}
        <Link to={`/contracts/${id}`} onClick={staffGo}>
          open the contract
        </Link>
        {c && c.lot && c.lot._id ? (
          <>
            {' · '}
            <Link to={`/lots/${c.lot._id}`} onClick={staffGo}>
              back to the lot
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

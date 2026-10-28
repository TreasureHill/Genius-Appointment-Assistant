import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { fmtMoney } from '../components/contracts/bits.jsx';
import { usePortalAuth, errText, fmtDate, dayOrdinal } from './portalAuth.jsx';

const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 30000;

// /portal/pay?contract=<id> — the target of every "set up your payment"
// email. Checkout sessions are created fresh on each click (their URLs
// expire), and the page never takes "?checkout=success" at its word: only the
// server's view of the contract, which the Stripe webhook updates, counts.
export default function PortalPay() {
  const { me, refresh } = usePortalAuth();
  const [params] = useSearchParams();
  const contracts = (me && me.contracts) || [];
  const tz = me && me.timezone;
  const requested = params.get('contract');
  const checkoutResult = params.get('checkout'); // success | cancel | null
  const sessionId = params.get('session_id') || '';
  const summary =
    contracts.find((x) => x.id === requested) ||
    contracts.find((x) => x.status === 'awaiting_payment') ||
    contracts[0] ||
    null;
  const id = summary ? summary.id : '';

  const [c, setC] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    document.title = 'Set up payment · Genius Smart Home';
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setC(null);
    setLoadErr('');
    api
      .get(`/api/portal/contracts/${id}`)
      .then((r) => !cancelled && setC(r))
      .catch((ex) => !cancelled && setLoadErr(errText(ex)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return (
      <>
        <h1>Set up payment</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            There's no monitoring agreement on this account yet. <Link to="/portal">Back to my account</Link>
          </p>
        </div>
      </>
    );
  }

  if (checkoutResult === 'success') {
    return <CheckoutConfirm id={id} sessionId={sessionId} tz={tz} contract={c} onSettled={refresh} />;
  }

  async function startCheckout() {
    setErr('');
    setBusy(true);
    try {
      const r = await api.post(`/api/portal/contracts/${id}/checkout`);
      if (r && r.url) {
        // Leave busy on: the browser is navigating to Stripe.
        window.location.assign(r.url);
        return;
      }
      setErr('Payment could not be started. Please try again.');
    } catch (ex) {
      setErr(errText(ex));
    }
    setBusy(false);
  }

  const pricing = c && c.pricing;

  return (
    <>
      <div className="portal-head">
        <h1>Set up payment</h1>
        <Link to={`/portal?contract=${id}`} className="portal-back">
          Back to my account
        </Link>
      </div>

      {checkoutResult === 'cancel' && (
        <div className="card alert alert-warn portal-banner">
          <h3>Payment not completed</h3>
          <p className="muted">No charge was made. You can try again whenever you're ready.</p>
        </div>
      )}

      {loadErr && <div className="card alert alert-err">{loadErr}</div>}
      {!c && !loadErr && <div className="muted portal-loading">Loading…</div>}

      {c && c.status !== 'awaiting_payment' && (
        <div className="card">
          {['active', 'past_due', 'unpaid'].includes(c.status) ? (
            <p style={{ margin: 0 }}>
              Your monthly payment is already set up. <Link to={`/portal?contract=${id}`}>View your account</Link> to see
              payments or update your card.
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              There's no payment to set up for this agreement right now.{' '}
              <Link to={`/portal?contract=${id}`}>Back to my account</Link>
            </p>
          )}
        </div>
      )}

      {c && c.status === 'awaiting_payment' && c.needsAttention === 'package_missing' && (
        <div className="card alert alert-warn portal-banner">
          <h3>We're confirming your package</h3>
          <p className="muted">
            We need to confirm which monitoring package you chose before payment can be set up. Genius Smart Home will
            contact you shortly.
          </p>
        </div>
      )}

      {c && c.status === 'awaiting_payment' && !c.needsAttention && (
        <section className="card portal-pay">
          <div className="portal-pay-pkg">{c.packageLabel}</div>
          <div className="muted portal-pay-prop">
            {[c.property.address, c.property.lotNumber ? `Lot ${c.property.lotNumber}` : ''].filter(Boolean).join(' · ')}
          </div>

          {pricing && (
            <>
              <dl className="portal-pay-lines">
                <div>
                  <dt>Monitoring</dt>
                  <dd>{fmtMoney(pricing.unitCents)}</dd>
                </div>
                <div>
                  <dt>HST ({(pricing.taxBps || 1300) / 100}%)</dt>
                  <dd>{fmtMoney(pricing.taxCents)}</dd>
                </div>
                <div className="portal-pay-total">
                  <dt>First payment today</dt>
                  <dd>{fmtMoney(pricing.totalCents)}</dd>
                </div>
              </dl>
              <p className="portal-pay-then">
                Then {fmtMoney(pricing.totalCents)} (including HST) on the {dayOrdinal(new Date(), tz)} of each month.
                You can update your card at any time from your account.
              </p>
            </>
          )}

          {c.actions.checkout ? (
            <button className="portal-wide portal-pay-btn" onClick={startCheckout} disabled={busy}>
              {busy ? 'Opening secure payment…' : 'Continue to secure payment'}
            </button>
          ) : (
            <p className="muted">Online payment setup isn't available right now. Please check back later.</p>
          )}
          {err && (
            <div className="error" role="alert">
              {err}
            </div>
          )}
          <p className="muted portal-fine">
            You'll enter your card on a secure page run by Stripe, our payment processor. Genius never sees your full
            card number.
          </p>
        </section>
      )}
    </>
  );
}

// After Stripe redirects back: ask the server (checkout-status, which may
// nudge a reconcile for a genuine session of this contract) until it says
// the subscription is live, for up to 30 seconds.
function CheckoutConfirm({ id, sessionId, tz, contract, onSettled }) {
  // polling | active | settled_other | timeout | error
  const [phase, setPhase] = useState('polling');
  const [status, setStatus] = useState(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const started = Date.now();
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';

    async function tick() {
      let r = null;
      try {
        r = await api.get(`/api/portal/contracts/${id}/checkout-status${qs}`);
      } catch (ex) {
        // 404 / 401 won't fix themselves; anything else is worth another try.
        if (!cancelled && (ex.status === 404 || ex.status === 401)) {
          setPhase('error');
          return;
        }
      }
      if (cancelled) return;
      if (r) {
        setStatus(r);
        if (r.active) {
          setPhase('active');
          settledRef.current && settledRef.current();
          return;
        }
        if (['past_due', 'unpaid', 'canceled'].includes(r.status)) {
          setPhase('settled_other');
          settledRef.current && settledRef.current();
          return;
        }
      }
      if (Date.now() - started >= POLL_FOR_MS) {
        setPhase('timeout');
        return;
      }
      timer = setTimeout(tick, POLL_EVERY_MS);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, sessionId]);

  const home = `/portal?contract=${id}`;
  const total = contract && contract.pricing ? fmtMoney(contract.pricing.totalCents) : '';

  return (
    <>
      <h1>Set up payment</h1>
      {phase === 'polling' && (
        <div className="card portal-banner" role="status">
          <h3>Confirming your payment…</h3>
          <p className="muted">This usually takes a few seconds. Please keep this page open.</p>
          <div className="portal-progress" aria-hidden="true">
            <span />
          </div>
        </div>
      )}
      {phase === 'active' && (
        <div className="card alert alert-ok portal-banner" role="status">
          <h3>Payment set up</h3>
          <p className="muted">
            Thank you. Your monitoring is active
            {status && status.card ? ` and your card ending ${status.card.last4} is on file` : ''}.
            {status && status.nextChargeAt
              ? ` Your next payment${total ? ` of ${total}` : ''} is on ${fmtDate(status.nextChargeAt, tz)}.`
              : ''}{' '}
            A receipt is on its way by email.
          </p>
          <Link to={home} className="btn-link portal-cta">
            Go to my account
          </Link>
        </div>
      )}
      {phase === 'settled_other' && (
        <div className="card alert alert-warn portal-banner" role="status">
          <h3>Your payment needs attention</h3>
          <p className="muted">Your card was saved, but the first payment didn't go through. Please check your account.</p>
          <Link to={home} className="btn-link portal-cta">
            Go to my account
          </Link>
        </div>
      )}
      {phase === 'timeout' && (
        <div className="card alert portal-banner" role="status">
          <h3>Confirmation is on its way</h3>
          <p className="muted">
            We haven't received confirmation from our payment processor yet. There's no need to pay again: we'll email
            you as soon as it's confirmed, and your account will update.
          </p>
          <Link to={home} className="btn-link portal-cta">
            Go to my account
          </Link>
        </div>
      )}
      {phase === 'error' && (
        <div className="card alert alert-err portal-banner" role="alert">
          <h3>We couldn't check your payment</h3>
          <p className="muted">Please log in again and open your account to see its status. Don't pay a second time.</p>
          <Link to="/portal" className="btn-link portal-cta">
            Go to my account
          </Link>
        </div>
      )}
    </>
  );
}

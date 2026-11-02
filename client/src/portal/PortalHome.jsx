import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { downloadFile } from '../download.js';
import { fmtMoney, PACKAGE_LABEL, CONTRACT_STATUS_META, PAYMENT_META } from '../components/contracts/bits.jsx';
import { usePortalAuth, errText, fmtDate, fmtShortDate } from './portalAuth.jsx';

// Labels a homeowner reads. The admin wording ("Awaiting payment setup",
// "Unpaid") is staff-facing; these say the same thing in plain terms.
const HOME_STATUS = {
  draft: { label: 'Preparing agreement', badge: 'pending' },
  sent: { label: 'Waiting for signatures', badge: 'contacted' },
  declined: { label: 'Declined', badge: 'opted_out' },
  voided: { label: 'Withdrawn', badge: 'completed' },
  awaiting_payment: { label: 'Payment not set up', badge: 'scheduled' },
  active: { label: 'Active', badge: 'ok' },
  past_due: { label: 'Payment overdue', badge: 'err' },
  unpaid: { label: 'Payment overdue', badge: 'err' },
  canceled: { label: 'Cancelled', badge: 'completed' },
};

const DOC_LABEL = {
  agreement_signed: 'Signed monitoring agreement',
  certificate: 'Signing certificate',
};

function StatusBadge({ status }) {
  const m = HOME_STATUS[status] || CONTRACT_STATUS_META[status] || { label: status, badge: 'pending' };
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

function PaymentStatus({ p }) {
  if (p.status === 'paid' && p.amountRefundedCents > 0) return <span className="badge completed">Refunded</span>;
  if (p.missed) return <span className="badge err">Missed</span>;
  if (p.status === 'open') return <span className="badge contacted">{p.nextPaymentAttempt ? 'Retrying' : 'Due'}</span>;
  const m = PAYMENT_META[p.status] || { label: p.status, badge: 'pending' };
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

function propertyLine(prop) {
  if (!prop) return '';
  const lot = prop.lotNumber ? `Lot ${prop.lotNumber}` : '';
  return [prop.address, [prop.projectName, lot].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
}

// Open a Stripe-hosted page (Billing Portal). The URL is created on demand
// for this session only, so it is never stored or emailed.
async function openBillingPortal(id, setErr, setBusy) {
  setErr('');
  setBusy(true);
  try {
    const r = await api.post(`/api/portal/contracts/${id}/billing-portal`);
    if (r && r.url) window.location.assign(r.url);
    else setBusy(false);
  } catch (ex) {
    setErr(errText(ex));
    setBusy(false);
  }
}

function StatusBanner({ c, tz, onManageCard, cardBusy }) {
  const payLink = `/portal/pay?contract=${c.id}`;
  if (c.status === 'awaiting_payment') {
    if (c.needsAttention === 'package_missing') {
      return (
        <div className="card alert alert-warn portal-banner">
          <h3>We're confirming your package</h3>
          <p className="muted">
            Your agreement is signed, but we need to confirm which monitoring package you chose. Genius Smart Home
            will contact you shortly; there's nothing you need to do yet.
          </p>
        </div>
      );
    }
    return (
      <div className="card alert alert-warn portal-banner">
        <h3>One last step: set up your monthly payment</h3>
        {c.actions.checkout ? (
          <>
            <p className="muted">
              Your agreement is signed. Add a card to start monitoring: the first payment of{' '}
              {fmtMoney(c.pricing && c.pricing.totalCents)} (including HST) is charged today, then monthly.
            </p>
            <Link to={payLink} className="btn-link portal-cta">
              Set up payment
            </Link>
          </>
        ) : (
          <p className="muted">
            Online payment setup isn't available right now. Genius Smart Home will be in touch, or check back later.
          </p>
        )}
      </div>
    );
  }
  if (c.status === 'past_due' || c.status === 'unpaid') {
    return (
      <div className="card alert alert-err portal-banner">
        <h3>Your last payment didn't go through</h3>
        <p className="muted">
          {c.billing.lastFailureMessage ? `${c.billing.lastFailureMessage} ` : ''}
          {c.billing.missedOpenCents > 0 ? `${fmtMoney(c.billing.missedOpenCents)} is outstanding. ` : ''}
          Update your card and we'll retry the payment automatically.
        </p>
        {c.actions.manageCard && (
          <button onClick={onManageCard} disabled={cardBusy}>
            {cardBusy ? 'Opening…' : 'Update card'}
          </button>
        )}
      </div>
    );
  }
  if (c.status === 'active') {
    return (
      <div className="card alert alert-ok portal-banner">
        <h3>Monitoring active</h3>
        <p className="muted">
          {c.billing.cancelAtPeriodEnd && c.billing.currentPeriodEnd
            ? `Your monitoring is set to end on ${fmtDate(c.billing.currentPeriodEnd, tz)}.`
            : c.nextChargeAt
              ? `Your next payment of ${fmtMoney(c.pricing && c.pricing.totalCents)} is on ${fmtDate(c.nextChargeAt, tz)}.`
              : 'Your home is being monitored.'}
        </p>
      </div>
    );
  }
  if (c.status === 'canceled') {
    return (
      <div className="card alert portal-banner">
        <h3>Monitoring cancelled</h3>
        <p className="muted">
          {c.billing.endedAt ? `Monitoring ended on ${fmtDate(c.billing.endedAt, tz)}. ` : ''}
          Contact Genius Smart Home if you'd like to restart it.
        </p>
      </div>
    );
  }
  if (c.status === 'sent' || c.status === 'draft') {
    return (
      <div className="card alert portal-banner">
        <h3>Your agreement is waiting for signatures</h3>
        <p className="muted">Once everyone has signed, you'll be able to set up your monthly payment here.</p>
      </div>
    );
  }
  return null;
}

export default function PortalHome() {
  const { me } = usePortalAuth();
  const [params, setParams] = useSearchParams();
  const contracts = (me && me.contracts) || [];
  const tz = me && me.timezone;
  const requested = params.get('contract');
  const selectedId = (contracts.find((c) => c.id === requested) || contracts[0] || {}).id || '';

  const [c, setC] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [actionErr, setActionErr] = useState('');
  const [cardBusy, setCardBusy] = useState(false);
  const [remBusy, setRemBusy] = useState(false);
  const [remMsg, setRemMsg] = useState('');
  const [docBusy, setDocBusy] = useState('');

  useEffect(() => {
    document.title = 'My account · Genius Smart Home';
  }, []);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoadErr('');
    try {
      setC(await api.get(`/api/portal/contracts/${selectedId}`));
    } catch (ex) {
      setC(null);
      setLoadErr(errText(ex));
    }
  }, [selectedId]);

  useEffect(() => {
    setC(null);
    setActionErr('');
    setRemMsg('');
    load();
  }, [load]);

  if (!contracts.length) {
    return (
      <>
        <h1>My account</h1>
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            There's no monitoring agreement on this account yet. If you think that's a mistake, contact Genius Smart
            Home using the details below.
          </p>
        </div>
        <HelpCard support={me && me.support} />
      </>
    );
  }

  async function toggleReminders(enabled) {
    setRemBusy(true);
    setRemMsg('');
    try {
      await api.patch(`/api/portal/contracts/${c.id}/reminders`, { enabled });
      setC((prev) => ({ ...prev, reminders: { ...prev.reminders, enabled } }));
      setRemMsg('Saved.');
    } catch (ex) {
      setRemMsg(errText(ex));
    } finally {
      setRemBusy(false);
    }
  }

  async function download(kind) {
    setActionErr('');
    setDocBusy(kind);
    try {
      await downloadFile(`/api/portal/contracts/${c.id}/documents/${kind}`, `${c.number}-${kind}.pdf`);
    } catch (ex) {
      setActionErr(errText(ex, 'The document could not be downloaded. Please try again.'));
    } finally {
      setDocBusy('');
    }
  }

  const manageCard = () => openBillingPortal(c.id, setActionErr, setCardBusy);
  const pricing = c && c.pricing;
  const card = c && c.billing && c.billing.card;

  return (
    <>
      <div className="portal-head">
        <h1>My account</h1>
        {contracts.length > 1 && (
          <label className="portal-select">
            <span>Home</span>
            <select
              value={selectedId}
              onChange={(e) => setParams({ contract: e.target.value }, { replace: true })}
              aria-label="Choose a home"
            >
              {contracts.map((x) => (
                <option key={x.id} value={x.id}>
                  {propertyLine(x.property) || x.number}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loadErr && (
        <div className="card alert alert-err">
          <p style={{ margin: 0 }}>{loadErr}</p>
          <button className="secondary small" style={{ marginTop: 10 }} onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!c && !loadErr && <div className="muted portal-loading">Loading your account…</div>}

      {c && (
        <>
          <div className="portal-property muted">
            {propertyLine(c.property)}
            {c.property && c.property.model ? ` · ${c.property.model}` : ''} · Agreement {c.number}
          </div>

          <StatusBanner c={c} tz={tz} onManageCard={manageCard} cardBusy={cardBusy} />
          {actionErr && (
            <div className="error" role="alert">
              {actionErr}
            </div>
          )}

          <div className="tiles portal-tiles">
            <div className="tile">
              <div className="label">Package</div>
              <div className="value portal-tile-text">{c.packageLabel || PACKAGE_LABEL[c.package] || 'Being confirmed'}</div>
            </div>
            <div className="tile">
              <div className="label">Monthly</div>
              <div className="value">{pricing ? fmtMoney(pricing.totalCents) : '—'}</div>
              {pricing && (
                <div className="portal-tile-sub muted">
                  {fmtMoney(pricing.unitCents)} + {fmtMoney(pricing.taxCents)} HST
                </div>
              )}
            </div>
            <div className="tile">
              <div className="label">Next charge</div>
              <div className="value portal-tile-text">{c.nextChargeAt ? fmtShortDate(c.nextChargeAt, tz) : '—'}</div>
              {card && <div className="portal-tile-sub muted">Card ending {card.last4}</div>}
            </div>
            <div className={`tile ${c.status === 'active' ? 'tile-ok' : ['past_due', 'unpaid'].includes(c.status) ? 'tile-err' : c.status === 'awaiting_payment' ? 'tile-warn' : ''}`}>
              <div className="label">Status</div>
              <div className="value portal-tile-text">
                <StatusBadge status={c.status} />
              </div>
            </div>
          </div>

          {(card || c.actions.manageCard) && (
            <section className="card">
              <h3 className="portal-card-title">Payment method</h3>
              <div className="portal-split">
                <div>
                  {card ? (
                    <>
                      <div>
                        {card.brand ? `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)}` : 'Card'} ending {card.last4}
                      </div>
                      {card.expMonth && card.expYear && (
                        <div className="muted">
                          Expires {String(card.expMonth).padStart(2, '0')}/{card.expYear}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="muted">No card on file.</div>
                  )}
                </div>
                {c.actions.manageCard && (
                  <button className="secondary" onClick={manageCard} disabled={cardBusy}>
                    {cardBusy ? 'Opening…' : 'Manage card'}
                  </button>
                )}
              </div>
              <p className="muted portal-fine">Card details are handled securely by Stripe; Genius never sees your full card number.</p>
            </section>
          )}

          <section className="card">
            <h3 className="portal-card-title">Payments</h3>
            {c.payments.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {c.status === 'awaiting_payment' ? 'No payments yet. Your first payment is taken when you set up payment.' : 'No payments yet.'}
              </p>
            ) : (
              <div className="portal-table-wrap">
                <table className="portal-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Receipt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="nowrap">
                          {fmtShortDate(p.paidAt || p.createdAt || p.periodStart, tz)}
                          {p.periodStart && p.periodEnd && (
                            <div className="muted portal-fine">
                              {fmtShortDate(p.periodStart, tz)} – {fmtShortDate(p.periodEnd, tz)}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">
                          {fmtMoney(p.totalCents)}
                          {p.taxCents > 0 && <div className="muted portal-fine">incl. {fmtMoney(p.taxCents)} HST</div>}
                        </td>
                        <td>
                          <PaymentStatus p={p} />
                        </td>
                        <td className="portal-links">
                          {p.hostedInvoiceUrl && (
                            <a href={p.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                              View
                            </a>
                          )}
                          {p.invoicePdfUrl && (
                            <a href={p.invoicePdfUrl} target="_blank" rel="noopener noreferrer">
                              PDF
                            </a>
                          )}
                          {!p.hostedInvoiceUrl && !p.invoicePdfUrl && <span className="muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h3 className="portal-card-title">Documents</h3>
            {c.documents.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Your signed agreement will appear here once everyone has signed.
              </p>
            ) : (
              <ul className="portal-docs">
                {c.documents.map((d) => (
                  <li key={d.kind}>
                    <div>
                      <div>{DOC_LABEL[d.kind] || d.filename}</div>
                      <div className="muted portal-fine">
                        PDF{d.size ? ` · ${Math.max(1, Math.round(d.size / 1024))} KB` : ''}
                        {d.createdAt ? ` · ${fmtShortDate(d.createdAt, tz)}` : ''}
                      </div>
                    </div>
                    <button className="secondary small" onClick={() => download(d.kind)} disabled={docBusy === d.kind}>
                      {docBusy === d.kind ? 'Downloading…' : 'Download'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {['awaiting_payment', 'active', 'past_due', 'unpaid'].includes(c.status) && (
            <section className="card">
              <h3 className="portal-card-title">Email preferences</h3>
              <label className="portal-check">
                <input
                  type="checkbox"
                  checked={c.reminders.enabled}
                  disabled={remBusy}
                  onChange={(e) => toggleReminders(e.target.checked)}
                />
                <span>
                  Email me {c.reminders.daysBefore} {c.reminders.daysBefore === 1 ? 'day' : 'days'} before each payment
                </span>
              </label>
              {!c.reminders.globalEnabled && (
                <p className="muted portal-fine">Payment reminder emails are currently paused for all customers.</p>
              )}
              <p className="muted portal-fine">
                Receipts and notices about failed payments are always sent.
                {remMsg && <span className={remMsg === 'Saved.' ? 'portal-saved' : 'portal-save-err'}> {remMsg}</span>}
              </p>
            </section>
          )}
        </>
      )}

      <HelpCard support={me && me.support} />
    </>
  );
}

function HelpCard({ support }) {
  const s = support || {};
  return (
    <section className="card portal-help">
      <h3 className="portal-card-title">Need help?</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Questions about your monitoring, your agreement or a payment? Contact {s.name || 'Genius Smart Home'}.
      </p>
      <div className="portal-contacts">
        {s.phone && <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`}>{s.phone}</a>}
        {s.email && <a href={`mailto:${s.email}`}>{s.email}</a>}
      </div>
    </section>
  );
}

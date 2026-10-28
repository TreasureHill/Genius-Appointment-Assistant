const env = require('../../config/env');
const { splitRecipients } = require('../emailFormat');
const { formatInTimezone, resolveScheduleTimezone, DEFAULT_TIMEZONE } = require('../sendWindow');
const { PACKAGES, quote, isValidPackage, fmtCad } = require('./pricing');

// Alarm monitoring contract emails — our own nodemailer emails (Stripe's
// receipts / renewal reminders are switched off) so the toggles work.
//
// Owner: emails/portal-accounts track.
//
// sendContractEmail is the ONLY way contract code sends mail:
//  - calls mailer.sendEmail directly — NEVER the Outbox (the sender worker
//    cancels outbox rows for lots in STOP_STATUSES, e.g. 'completed')
//  - default recipients: emailFormat.splitRecipients(signer emails) → To the
//    primary purchaser, CC the co-buyers; BCC Setting.alarm.contractsCcEmail
//    (except welcome / password_reset: they carry a personal one-time link,
//    and a copy in a shared inbox would let its readers claim the account).
//    `to` overrides (welcome / password_reset go to one person, no CC;
//    admin_alert goes to contractsCcEmail || Setting.owner.email)
//  - checks the gates below unless force:true
//  - writes a MessageLog row (type 'email', lot, project,
//    sendGroup `contract:<id>:<kind>`, isReminder for upcoming_payment) and a
//    ContractEvent (welcome→invite_sent, upcoming_payment→reminder_sent,
//    receipt→invoice_emailed, card_expiring→card_expiry_notice,
//    payment_nudge→nudge_sent, others→email_sent; failures→email_failed)
//  - NEVER throws: returns { ok:false, error } instead
//  - emails never contain a Stripe Checkout URL (they expire) — link to the
//    portal (portalUrl('/pay?contract=<id>')), which opens a fresh session
//
// Gates (force:true skips them — admin manual sends):
//   upcoming_payment, card_expiring : alarm.paymentRemindersEnabled && contract.reminders.enabled
//   receipt                         : alarm.autoSendInvoices && contract.invoiceEmails.enabled
//   payment_failed                  : alarm.sendFailedPaymentEmails
//   everything else                 : always

const EMAIL_KINDS = Object.freeze([
  'welcome',
  'payment_nudge',
  'upcoming_payment',
  'receipt',
  'payment_failed',
  'card_expiring',
  'password_reset',
  'canceled',
  'admin_alert',
]);

/** `${appUrl}/portal${path}` (pure). */
function portalUrl(path = '') {
  const p = String(path || '');
  return `${env.appUrl}/portal${p && !p.startsWith('/') ? '/' : ''}${p}`;
}

/**
 * Personal one-time link (pure). Token goes in the fragment.
 * invite → /portal/set-password#t=…, reset → /portal/reset#t=…
 */
function setPasswordUrl(rawToken, purpose = 'invite') {
  const page = purpose === 'reset' ? 'reset' : 'set-password';
  return `${portalUrl(`/${page}`)}#t=${encodeURIComponent(rawToken)}`;
}

/** Portal pay page for a contract (pure). Safe to put in any email. */
function payUrl(contractId) {
  return portalUrl(`/pay?contract=${encodeURIComponent(String(contractId))}`);
}

/**
 * Every builder: (ctx) → { subject, html, text? } — PURE (no DB / network).
 * ctx = { contract, setting, tz, data } where tz = resolveScheduleTimezone(setting)
 * and `data` is the per-kind payload below. Style: services/emailPresets.js
 * (plain paragraphs, inline styles, no images); footer
 * "Genius Smart Home · a Treasure Hill company"; dates via
 * sendWindow.formatInTimezone(d, tz, {hour: undefined, minute: undefined, ...}).
 *
 * data per kind:
 *   welcome          { actionUrl, hasPassword, recipientName }
 *   payment_nudge    { payUrl? }                     (default payUrl(contract._id))
 *   upcoming_payment { chargeDate?, unitCents?, taxCents?, totalCents?, last4? } (defaults from contract)
 *   receipt          { payment }                     (ContractPayment; includes HST # env.hst.registrationNumber)
 *   payment_failed   { payment, failureMessage?, nextAttemptAt? }
 *   card_expiring    { expMonth, expYear, chargeDate }
 *   password_reset   { actionUrl, recipientName?, purpose? }  // purpose 'invite' = 7-day link
 *   canceled         { atPeriodEnd, endsAt?, reason? }
 *   admin_alert      { title, lines: string[], alertKind }  // to staff
 */

// ---------------------------------------------------------------------------
// Shared building blocks. Inline styles only (mail clients drop <style>), no
// images, left-aligned paragraphs like the Genius appointment email.
// ---------------------------------------------------------------------------

const FONT = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;';
const P = 'margin:0 0 14px;';
const LINK = 'color:#0000EE;text-decoration:underline;';
const MUTED = 'color:#555555;font-size:12px;';
const TD = 'padding:4px 16px 4px 0;vertical-align:top;';
const TD_NUM = 'padding:4px 0;text-align:right;vertical-align:top;white-space:nowrap;';
const FOOTER = 'Genius Smart Home · a Treasure Hill company';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "October 31, 2026" in the schedule timezone, so a charge at 00:30 UTC isn't
// announced for the previous evening's date in Toronto (or vice versa).
function fmtDate(d, tz) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return formatInTimezone(date, tz || DEFAULT_TIMEZONE, {
    weekday: undefined,
    hour: undefined,
    minute: undefined,
    timeZoneName: undefined,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// "Jane Doe", "Jane Doe and John Smith", "A, B and C" — names of everyone the
// email is addressed to (the primary is on To, the rest CC'd).
function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// Greets the people the email actually goes to: signers with an email (the
// same list resolveRecipients uses), else anyone with an email.
function purchaserNames(contract) {
  const all = (contract && contract.purchasers) || [];
  const withEmail = all.filter((p) => p && String(p.email || '').trim());
  const signers = withEmail.filter((p) => p.signs !== false);
  const seen = new Set();
  const names = [];
  for (const p of signers.length ? signers : withEmail) {
    const n = String(p.name || '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    names.push(n);
  }
  return joinNames(names);
}

function greeting(name) {
  const n = String(name || '').trim();
  return `<p style="${P}">${n ? `Dear ${esc(n)},` : 'Hello,'}</p>`;
}

// A link styled as a button. Explicit white text colour so emailFormat's
// styleLinks leaves it alone; the URL is also printed underneath for clients
// that strip the background.
function button(url, label) {
  const u = esc(url);
  return (
    `<p style="margin:0 0 6px;"><a href="${u}" target="_blank" style="display:inline-block;background:#1F4E79;color:#FFFFFF;` +
    `text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:4px;">${esc(label)}</a></p>` +
    `<p style="${P}${MUTED}">Or open this link: <a href="${u}" target="_blank" style="${LINK}">${u}</a></p>`
  );
}

function link(url, label) {
  return `<a href="${esc(url)}" target="_blank" style="${LINK}">${esc(label)}</a>`;
}

// rows: [[label, value, {bold}]]
function amountTable(rows) {
  const tr = rows
    .filter(Boolean)
    .map(([label, value, opts = {}]) => {
      const b = opts.bold ? 'font-weight:bold;' : '';
      return `<tr><td style="${TD}${b}">${esc(label)}</td><td style="${TD_NUM}${b}">${esc(value)}</td></tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px;${FONT}">${tr}</table>`;
}

function propertyLine(contract) {
  const pr = (contract && contract.property) || {};
  const bits = [];
  if (pr.lotNumber) bits.push(`Lot ${pr.lotNumber}`);
  if (pr.projectName) bits.push(pr.projectName);
  const where = bits.join(', ');
  return pr.address ? `${pr.address}${where ? ` (${where})` : ''}` : where;
}

function contactLine(setting) {
  const owner = (setting && setting.owner) || {};
  const parts = [];
  if (owner.email) parts.push(link(`mailto:${owner.email}`, owner.email));
  if (owner.phone) parts.push(link(`tel:${String(owner.phone).replace(/[^\d+]/g, '')}`, owner.phone));
  return parts.length
    ? `<p style="${P}">Questions? Reply to this email or contact us at ${parts.join(' or ')}.</p>`
    : `<p style="${P}">Questions? Simply reply to this email.</p>`;
}

function layout(body, { setting, contract } = {}) {
  const ref = contract && contract.number ? `Agreement ${esc(contract.number)} · ` : '';
  return (
    `<div style="${FONT}">\n${body}\n${contactLine(setting)}` +
    `<p style="margin:0 0 4px;">Regards,</p><p style="${P}">Genius Smart Home</p>` +
    `<p style="margin:18px 0 0;${MUTED}">${ref}${esc(FOOTER)}</p>\n</div>`
  );
}

// Unit / tax / total for the contract: the stored pricing snapshot wins (it is
// what the homeowner agreed to), the code price list is the fallback.
function contractAmounts(contract) {
  const pr = (contract && contract.pricing) || {};
  if (pr.totalCents != null && pr.unitCents != null) {
    return { unitCents: pr.unitCents, taxCents: pr.taxCents, totalCents: pr.totalCents };
  }
  if (contract && isValidPackage(contract.package)) {
    const q = quote(contract.package);
    return { unitCents: q.unitCents, taxCents: q.taxCents, totalCents: q.totalCents };
  }
  return { unitCents: null, taxCents: null, totalCents: null };
}

function packageLabel(contract) {
  return contract && PACKAGES[contract.package] ? PACKAGES[contract.package].label : 'Alarm monitoring';
}

function breakdownRows(label, a) {
  return [
    [label, fmtCad(a.unitCents)],
    ['HST (13%)', fmtCad(a.taxCents)],
    ['Total per month', fmtCad(a.totalCents), { bold: true }],
  ];
}

const contractId = (c) => String((c && c._id) || '');

// ---------------------------------------------------------------------------
// Builders (pure)
// ---------------------------------------------------------------------------

/** Signed: create your password (or log in) + set up payment. Signed PDF attached by the caller. */
function welcomeSignedEmail({ contract, setting, data = {} }) {
  const label = packageLabel(contract);
  const a = contractAmounts(contract);
  const awaitingPayment = !contract.status || contract.status === 'awaiting_payment';
  const where = propertyLine(contract);
  const body = [
    greeting(data.recipientName || purchaserNames(contract)),
    `<p style="${P}">Thank you for signing your Genius alarm monitoring agreement${where ? ` for ${esc(where)}` : ''}. A copy of the signed agreement is attached to this email for your records.</p>`,
    `<p style="margin:0 0 6px;"><strong>Your package: ${esc(label)}</strong></p>`,
    a.totalCents != null ? amountTable(breakdownRows(`${label}, monthly`, a)) : '',
  ];
  if (data.hasPassword) {
    body.push(`<p style="${P}">You already have a Genius homeowner account. Log in with your email and password to see your agreement${awaitingPayment ? ' and set up your monthly payment' : ''}.</p>`);
    body.push(button(data.actionUrl, awaitingPayment ? 'Log in and set up payment' : 'Log in to your account'));
  } else {
    body.push(`<p style="${P}">Next, create a password for your Genius homeowner account. You will use it to see your agreement, payments and receipts.</p>`);
    body.push(button(data.actionUrl, 'Create your password'));
    body.push(`<p style="${P}${MUTED}">This link is personal to you and can be used once. It expires in 7 days; after that, use "Forgot password" on the log-in page to get a new one.</p>`);
  }
  if (awaitingPayment && a.totalCents != null) {
    body.push(
      `<p style="${P}">Once your password is set you will be taken to our secure payment page. Your first payment of <strong>${esc(fmtCad(a.totalCents))}</strong> (including HST) is charged when you complete it, and then automatically on the same day each month.</p>`
    );
  }
  return {
    subject: 'Your Genius alarm monitoring agreement is signed — set up your account',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** One-time nudge, 3 days after signing, still awaiting payment. */
function paymentSetupNudgeEmail({ contract, setting, data = {} }) {
  const a = contractAmounts(contract);
  const label = packageLabel(contract);
  const body = [
    greeting(purchaserNames(contract)),
    `<p style="${P}">Your Genius alarm monitoring agreement is signed, but your monthly payment hasn't been set up yet, so monitoring has not started.</p>`,
    a.totalCents != null ? amountTable(breakdownRows(`${label}, monthly`, a)) : '',
    `<p style="${P}">It only takes a minute. Your first payment is charged when you finish, then monthly on the same day.</p>`,
    button(data.payUrl || payUrl(contractId(contract)), 'Set up your payment'),
    `<p style="${P}${MUTED}">Haven't created your password yet? Use "Forgot password" on the log-in page and we'll email you a new link.</p>`,
  ];
  return {
    subject: 'One last step: set up your Genius monitoring payment',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** "Upcoming invoice": amount with the HST breakdown, charge date, card last4. */
function upcomingPaymentEmail({ contract, setting, tz, data = {} }) {
  const b = (contract && contract.billing) || {};
  const base = contractAmounts(contract);
  const a = {
    unitCents: data.unitCents != null ? data.unitCents : base.unitCents,
    taxCents: data.taxCents != null ? data.taxCents : base.taxCents,
    totalCents: data.totalCents != null ? data.totalCents : base.totalCents,
  };
  const when = fmtDate(data.chargeDate || b.currentPeriodEnd, tz);
  const last4 = data.last4 || b.pmLast4 || '';
  const label = packageLabel(contract);
  const card = last4 ? `your card ending in ${esc(last4)}` : 'your card on file';
  const body = [
    greeting(purchaserNames(contract)),
    `<p style="${P}">This is a reminder that we'll charge <strong>${esc(fmtCad(a.totalCents))}</strong> (${esc(label)} ${esc(fmtCad(a.unitCents))} + HST ${esc(fmtCad(a.taxCents))}) to ${card}${when ? ` on <strong>${esc(when)}</strong>` : ''}.</p>`,
    amountTable([...breakdownRows(label, a), when ? ['Charge date', when] : null, last4 ? ['Card', `ending in ${last4}`] : null]),
    `<p style="${P}">Nothing to do if your card is up to date. To change it, ${link(portalUrl('/'), 'log in to your account')} and choose Manage card.</p>`,
    `<p style="${P}${MUTED}">You can turn these reminders off in your ${link(portalUrl('/'), 'account preferences')}.</p>`,
  ];
  return {
    subject: `Upcoming Genius monitoring payment${when ? ` on ${when}` : ''}: ${fmtCad(a.totalCents)}`,
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** Receipt for a paid invoice: number, period, subtotal, HST, total, links, HST #. */
function invoiceReceiptEmail({ contract, setting, tz, data = {} }) {
  const pay = data.payment || {};
  const b = (contract && contract.billing) || {};
  const hstNo = data.hstRegistrationNumber != null ? data.hstRegistrationNumber : env.hst.registrationNumber;
  const period = pay.periodStart && pay.periodEnd ? `${fmtDate(pay.periodStart, tz)} to ${fmtDate(pay.periodEnd, tz)}` : '';
  const paidCents = pay.amountPaidCents || pay.totalCents;
  const rows = [
    pay.number ? ['Invoice number', pay.number] : null,
    pay.paidAt ? ['Paid on', fmtDate(pay.paidAt, tz)] : null,
    period ? ['Service period', period] : null,
    [packageLabel(contract), fmtCad(pay.subtotalCents)],
    ['HST (13%)', fmtCad(pay.taxCents)],
    ['Total', fmtCad(pay.totalCents), { bold: true }],
    paidCents !== pay.totalCents ? ['Amount paid', fmtCad(paidCents)] : null,
    b.pmLast4 ? ['Card', `ending in ${b.pmLast4}`] : null,
  ];
  const links = [];
  if (pay.hostedInvoiceUrl) links.push(link(pay.hostedInvoiceUrl, 'View invoice'));
  if (pay.invoicePdfUrl) links.push(link(pay.invoicePdfUrl, 'Download PDF'));
  const body = [
    greeting(purchaserNames(contract)),
    `<p style="${P}">Thank you. We received your payment of <strong>${esc(fmtCad(paidCents))}</strong> for Genius alarm monitoring.</p>`,
    amountTable(rows),
    links.length ? `<p style="${P}">${links.join(' &nbsp;|&nbsp; ')}</p>` : '',
    hstNo ? `<p style="${P}${MUTED}">HST registration number: ${esc(hstNo)}</p>` : '',
    `<p style="${P}${MUTED}">All your receipts are also in your ${link(portalUrl('/'), 'Genius homeowner account')}.</p>`,
  ];
  return {
    subject: `Receipt for your Genius monitoring payment${pay.number ? ` (${pay.number})` : ''}`,
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** A charge failed: amount, reason, next retry, update-card link. */
function paymentFailedEmail({ contract, setting, tz, data = {} }) {
  const pay = data.payment || {};
  const owed = pay.amountRemainingCents || pay.amountDueCents || pay.totalCents || contractAmounts(contract).totalCents;
  const reason = data.failureMessage || pay.failureMessage || '';
  const next = data.nextAttemptAt || pay.nextPaymentAttempt || null;
  const body = [
    greeting(purchaserNames(contract)),
    `<p style="${P}">We couldn't process your Genius alarm monitoring payment of <strong>${esc(fmtCad(owed))}</strong>${pay.number ? ` (invoice ${esc(pay.number)})` : ''}.</p>`,
    reason ? `<p style="${P}">Reason given by the card issuer: ${esc(reason)}</p>` : '',
    next
      ? `<p style="${P}">We'll try again automatically on <strong>${esc(fmtDate(next, tz))}</strong>. Updating your card before then avoids any interruption.</p>`
      : `<p style="${P}">Please update your card so we can collect the payment and keep your monitoring active.</p>`,
    button(portalUrl('/'), 'Update your card'),
    pay.hostedInvoiceUrl ? `<p style="${P}">You can also ${link(pay.hostedInvoiceUrl, 'pay this invoice online')}.</p>` : '',
  ];
  return {
    subject: 'Action needed: your Genius monitoring payment did not go through',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** Card on file expires before the next charge. */
function cardExpiringEmail({ contract, setting, tz, data = {} }) {
  const b = (contract && contract.billing) || {};
  const mm = String(data.expMonth || b.pmExpMonth || '').padStart(2, '0');
  const yyyy = String(data.expYear || b.pmExpYear || '');
  const when = fmtDate(data.chargeDate || b.currentPeriodEnd, tz);
  const card = b.pmLast4 ? `card ending in ${esc(b.pmLast4)}` : 'card on file';
  const body = [
    greeting(purchaserNames(contract)),
    `<p style="${P}">The ${card} for your Genius alarm monitoring expires ${esc(`${mm}/${yyyy}`)}${when ? `, before your next payment on <strong>${esc(when)}</strong>` : ''}.</p>`,
    `<p style="${P}">Please add your new card so your monitoring isn't interrupted.</p>`,
    button(portalUrl('/'), 'Update your card'),
  ];
  return {
    subject: 'Your card on file expires before your next Genius monitoring payment',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** Forgot password (1 hour link). */
function passwordResetEmail({ contract, setting, data = {} }) {
  const body = [
    greeting(data.recipientName || ''),
    `<p style="${P}">We received a request to reset the password for your Genius homeowner account.</p>`,
    button(data.actionUrl, 'Choose a new password'),
    // purpose 'invite': the account never had a password, so the link is a
    // fresh 7-day set-password link (routes/portal.js sendResetEmail).
    `<p style="${P}${MUTED}">This link can be used once and expires in ${data.purpose === 'invite' ? '7 days' : '1 hour'}. If you didn't ask for this, you can ignore this email; your password won't change.</p>`,
  ];
  return {
    subject: 'Reset your Genius homeowner account password',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/**
 * Monitoring cancelled (now, or at the end of the period). data.reason is the
 * staff note and is deliberately NOT quoted to the homeowner (it may be an
 * internal remark); it is in the contract history instead.
 */
function canceledEmail({ contract, setting, tz, data = {} }) {
  const ends = fmtDate(data.endsAt, tz);
  const body = [
    greeting(purchaserNames(contract)),
    data.atPeriodEnd
      ? `<p style="${P}">As requested, your Genius alarm monitoring will end${ends ? ` on <strong>${esc(ends)}</strong>` : ' at the end of the current billing period'}. You will not be charged again.</p>`
      : `<p style="${P}">Your Genius alarm monitoring has been cancelled${ends ? ` as of <strong>${esc(ends)}</strong>` : ''}. You will not be charged again.</p>`,
    `<p style="${P}">Your signed agreement and past receipts stay available in your ${link(portalUrl('/'), 'Genius homeowner account')}.</p>`,
    `<p style="${P}">If this is a mistake, or you'd like to restart monitoring, just reply to this email.</p>`,
  ];
  return {
    subject: 'Your Genius alarm monitoring has been cancelled',
    html: layout(body.join('\n'), { setting, contract }),
  };
}

/** Internal alert to staff (declined, voided, package missing, payment failed …). */
function adminAlertEmail({ contract, data = {} }) {
  const lines = (data.lines || []).filter(Boolean);
  const id = contractId(contract);
  const where = contract ? propertyLine(contract) : '';
  const body = [
    `<p style="${P}"><strong>${esc(data.title || 'Alarm monitoring alert')}</strong></p>`,
    contract ? `<p style="${P}">Agreement ${esc(contract.number || id)}${where ? `, ${esc(where)}` : ''}${purchaserNames(contract) ? `, ${esc(purchaserNames(contract))}` : ''}</p>` : '',
    lines.length ? `<ul style="margin:0 0 14px;padding-left:24px;">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '',
    id ? `<p style="${P}">${link(`${env.appUrl}/contracts/${encodeURIComponent(id)}`, 'Open the contract')}</p>` : '',
    `<p style="margin:18px 0 0;${MUTED}">Automatic alert (${esc(data.alertKind || 'alert')}) from the Genius appointment assistant.</p>`,
  ];
  return {
    subject: `[Genius monitoring] ${data.title || 'Alert'}`,
    html: `<div style="${FONT}">\n${body.join('\n')}\n</div>`,
  };
}

const BUILDERS = Object.freeze({
  welcome: welcomeSignedEmail,
  payment_nudge: paymentSetupNudgeEmail,
  upcoming_payment: upcomingPaymentEmail,
  receipt: invoiceReceiptEmail,
  payment_failed: paymentFailedEmail,
  card_expiring: cardExpiringEmail,
  password_reset: passwordResetEmail,
  canceled: canceledEmail,
  admin_alert: adminAlertEmail,
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

// Kinds whose body carries a personal one-time link (set-password / reset
// token). They go to exactly one person and are NOT BCC'd to the internal
// inbox: a copy there would let anyone reading that inbox claim the account.
const PERSONAL_LINK_KINDS = new Set(['welcome', 'password_reset']);

// Reminder-style kinds (MessageLog.isReminder).
const REMINDER_KINDS = new Set(['upcoming_payment', 'card_expiring', 'payment_nudge']);

const EVENT_TYPE_FOR_KIND = {
  welcome: 'invite_sent',
  upcoming_payment: 'reminder_sent',
  receipt: 'invoice_emailed',
  card_expiring: 'card_expiry_notice',
  payment_nudge: 'nudge_sent',
};

const KIND_LABEL = {
  welcome: 'Welcome email',
  payment_nudge: 'Payment setup reminder',
  upcoming_payment: 'Upcoming payment reminder',
  receipt: 'Receipt',
  payment_failed: 'Payment failed email',
  card_expiring: 'Card expiring notice',
  password_reset: 'Password reset email',
  canceled: 'Cancellation email',
  admin_alert: 'Internal alert',
};

/**
 * Is this kind allowed to send right now? (pure) force skips it in
 * sendContractEmail. A missing toggle counts as on (the schema defaults).
 */
function isKindEnabled(kind, setting, contract) {
  const alarm = (setting && setting.alarm) || {};
  const on = (v) => v !== false;
  switch (kind) {
    case 'upcoming_payment':
    case 'card_expiring':
      return on(alarm.paymentRemindersEnabled) && on(contract && contract.reminders && contract.reminders.enabled);
    case 'receipt':
      return on(alarm.autoSendInvoices) && on(contract && contract.invoiceEmails && contract.invoiceEmails.enabled);
    case 'payment_failed':
      return on(alarm.sendFailedPaymentEmails);
    default:
      return true;
  }
}

/**
 * Who gets this email (pure). Default: signers with an email in purchaser
 * order — the primary on To, the co-buyers on CC (emailFormat.splitRecipients
 * drops repeats, so a shared inbox gets one copy). `to` overrides that list.
 * admin_alert goes to contractsCcEmail, else the owner's email.
 * BCC = contractsCcEmail, except personal-link kinds and admin alerts, and
 * never when it is already a To/CC address.
 * @returns {{to: string, cc: string, bcc: string, recipients: Array<{role, name, address}>}}
 */
function resolveRecipients({ contract, kind, to, setting }) {
  const alarm = (setting && setting.alarm) || {};
  const internal = String(alarm.contractsCcEmail || '').trim().toLowerCase();
  if (kind === 'admin_alert') {
    const addr = to || internal || String((setting && setting.owner && setting.owner.email) || '').trim();
    const r = splitRecipients(addr);
    return { to: r.to, cc: r.cc, bcc: '', recipients: r.to ? [{ role: 'staff', name: '', address: r.to }] : [] };
  }
  const purchasers = ((contract && contract.purchasers) || []).filter((p) => p && String(p.email || '').trim());
  let list;
  if (to) {
    list = splitRecipients(to);
  } else {
    const signers = purchasers.filter((p) => p.signs !== false);
    list = splitRecipients((signers.length ? signers : purchasers).map((p) => p.email));
  }
  const all = [list.to, ...String(list.cc || '').split(',')].map((a) => a.trim()).filter(Boolean);
  const recipients = all.map((address) => {
    const p = purchasers.find((x) => String(x.email).toLowerCase() === address.toLowerCase());
    return { role: (p && p.role) || '', name: (p && p.name) || '', address };
  });
  const bcc = !PERSONAL_LINK_KINDS.has(kind) && internal && !all.some((a) => a.toLowerCase() === internal) ? internal : '';
  return { to: list.to, cc: list.cc, bcc, recipients };
}

// The stored copy (MessageLog body, shown in Activity) never keeps a live
// one-time token: "#t=<token>" becomes "#t=redacted".
function redactTokens(html) {
  return String(html || '').replace(/#t=[^"'<>\s&]+/g, '#t=redacted');
}

// Injectable dependencies (tests replace them; no DB / SMTP in tests).
const deps = {
  smtpConfigured: () => env.smtp.configured,
  sendEmail: (msg) => require('../mailer').sendEmail(msg),
  getSetting: () => require('../../models/Setting').getSingleton(),
  logMessage: (row) => require('../../models/MessageLog').create(row),
  logContractEvent: (ev) => require('./eventLogger').logContractEvent(ev),
};

const plainObj = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

/**
 * Send one contract email. See the header for recipients, gates and logging.
 * @param {{contract: object, kind: string, data?: object, to?: string|string[],
 *   attachments?: Array<{filename: string, content: Buffer, contentType?: string}>,
 *   force?: boolean, actor?: string, actorName?: string}} a
 *   contract: AlarmContract doc/lean (needs _id, lot, project, number, purchasers…).
 *   Pass contract:null only for password_reset of a user with no contract.
 * @returns {Promise<{ok: boolean, skipped?: 'disabled'|'no_recipient'|'smtp_not_configured'|'not_implemented',
 *   messageId?: string, error?: string}>}
 */
async function sendContractEmail({ contract, kind, data = {}, to, attachments, force = false, actor = 'system', actorName = '' }) {
  const builder = BUILDERS[kind];
  if (!builder) return { ok: false, error: `unknown_email_kind:${kind}` };
  const c = plainObj(contract) || null;
  let setting = null;
  try {
    setting = plainObj(await deps.getSetting());
  } catch (err) {
    console.warn('[contracts] email settings unavailable', err.message);
  }
  if (!force && !isKindEnabled(kind, setting, c)) return { ok: false, skipped: 'disabled' };
  const rcpt = resolveRecipients({ contract: c, kind, to, setting });
  if (!rcpt.to) return { ok: false, skipped: 'no_recipient' };
  if (!deps.smtpConfigured()) return { ok: false, skipped: 'smtp_not_configured' };

  let built;
  try {
    built = builder({ contract: c || {}, setting: setting || {}, tz: resolveScheduleTimezone(setting), data: data || {} });
  } catch (err) {
    console.warn('[contracts] email build failed', kind, err.message);
    return { ok: false, error: `build_failed: ${err.message}` };
  }

  let messageId = '';
  let error = '';
  try {
    const r = await deps.sendEmail({
      to: rcpt.to,
      cc: rcpt.cc || undefined,
      bcc: rcpt.bcc || undefined,
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments,
    });
    messageId = (r && r.messageId) || '';
  } catch (err) {
    error = (err && err.message) || 'send_failed';
  }

  const id = c && c._id ? String(c._id) : 'none';
  try {
    await deps.logMessage({
      project: (c && c.project && (c.project._id || c.project)) || undefined,
      lot: (c && c.lot && (c.lot._id || c.lot)) || undefined,
      type: 'email',
      direction: 'out',
      to: rcpt.to,
      cc: rcpt.cc || '',
      subject: built.subject,
      body: redactTokens(built.html),
      status: error ? 'failed' : 'sent',
      providerId: messageId,
      error: error.slice(0, 500),
      sentAt: error ? null : new Date(),
      isReminder: REMINDER_KINDS.has(kind),
      sendGroup: `contract:${id}:${kind}`,
      recipients: rcpt.recipients,
    });
  } catch (err) {
    console.warn('[contracts] failed to log contract email', kind, err.message);
  }

  if (c && c._id) {
    const label = KIND_LABEL[kind] || kind;
    const who = [rcpt.to, rcpt.cc].filter(Boolean).join(', ');
    await deps.logContractEvent({
      contract: c,
      type: error ? 'email_failed' : EVENT_TYPE_FOR_KIND[kind] || 'email_sent',
      actor,
      actorName,
      message: error ? `${label} to ${who} failed: ${error}` : `${label} sent to ${who}`,
      meta: { kind, to: rcpt.to, cc: rcpt.cc || '', ...(messageId ? { messageId } : {}), ...(force ? { forced: true } : {}) },
    });
  }

  if (error) {
    console.warn('[contracts] contract email failed', kind, id, error);
    return { ok: false, error };
  }
  return { ok: true, messageId };
}

/**
 * Internal alert to contractsCcEmail (fallback Setting.owner.email). Thin
 * wrapper over sendContractEmail kind 'admin_alert'. Never throws.
 * @param {{contract?: object, alertKind: 'declined'|'voided'|'package_missing'|'payment_failed'|'double_subscription'|'catalog_mismatch'|string,
 *   title: string, lines?: string[]}} a
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
async function sendAdminAlert({ contract = null, alertKind, title, lines = [] }) {
  return sendContractEmail({ contract, kind: 'admin_alert', data: { alertKind, title, lines }, force: true });
}

module.exports = {
  EMAIL_KINDS,
  BUILDERS,
  portalUrl,
  setPasswordUrl,
  payUrl,
  welcomeSignedEmail,
  paymentSetupNudgeEmail,
  upcomingPaymentEmail,
  invoiceReceiptEmail,
  paymentFailedEmail,
  cardExpiringEmail,
  passwordResetEmail,
  canceledEmail,
  adminAlertEmail,
  sendContractEmail,
  sendAdminAlert,
  // helpers (pure) + test seam
  isKindEnabled,
  resolveRecipients,
  redactTokens,
  fmtDate,
  PERSONAL_LINK_KINDS,
  _deps: deps,
};

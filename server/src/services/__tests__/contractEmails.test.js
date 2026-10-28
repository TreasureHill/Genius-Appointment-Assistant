const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const env = require('../../config/env');
const emails = require('../contracts/emails');

// Contract email builders (pure) and sendContractEmail with its I/O stubbed
// through emails._deps — no SMTP, no database.

const TZ = 'America/Toronto';
const setting = {
  owner: { name: 'Genius', email: 'genius@treasurehill.com', phone: '416 561 4327' },
  alarm: { paymentRemindersEnabled: true, autoSendInvoices: true, sendFailedPaymentEmails: true, contractsCcEmail: 'contracts@treasurehill.com' },
};
const contract = {
  _id: '64b000000000000000000001',
  lot: '64b0000000000000000000aa',
  project: '64b0000000000000000000bb',
  number: 'GA-2026-00042',
  status: 'awaiting_payment',
  package: 'smart',
  pricing: { unitCents: 3299, taxBps: 1300, taxCents: 429, totalCents: 3728, currency: 'cad' },
  property: { projectName: 'Sereno', lotNumber: '0006', address: '12 Main St, Vaughan', model: 'A3END A' },
  purchasers: [
    { role: 'buyer', name: 'Jane Doe', email: 'jane@example.com' },
    { role: 'coBuyer', name: 'John Doe', email: 'john@example.com' },
    { role: 'thirdBuyer', name: 'No Mail', email: '' },
  ],
  billing: { status: 'active', currentPeriodEnd: new Date('2026-12-03T14:05:00Z'), pmLast4: '4242', pmExpMonth: 11, pmExpYear: 2026 },
  reminders: { enabled: true },
  invoiceEmails: { enabled: true },
};
const ctx = (data, over = {}) => ({ contract: { ...contract, ...over }, setting, tz: TZ, data });
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

group('links');
t('setPasswordUrl puts the token in the fragment, never the query', () => {
  const u = emails.setPasswordUrl('tok_ABC-123', 'invite');
  assert.strictEqual(u, `${env.appUrl}/portal/set-password#t=tok_ABC-123`);
  assert.ok(!u.includes('?'));
  assert.strictEqual(emails.setPasswordUrl('x', 'reset'), `${env.appUrl}/portal/reset#t=x`);
});
t('payUrl / portalUrl use APP_URL', () => {
  assert.strictEqual(emails.payUrl('abc'), `${env.appUrl}/portal/pay?contract=abc`);
  assert.strictEqual(emails.portalUrl('/'), `${env.appUrl}/portal/`);
});
t('redactTokens strips one-time tokens from stored copies', () => {
  const html = '<a href="https://x/portal/set-password#t=SECRETtoken_1">go</a> https://x/portal/reset#t=abc';
  const out = emails.redactTokens(html);
  assert.ok(!out.includes('SECRETtoken_1'));
  assert.ok(!out.includes('#t=abc'));
  assert.ok(out.includes('#t=redacted'));
});

group('builders');
t('every kind has a builder that returns subject + html', () => {
  for (const k of emails.EMAIL_KINDS) {
    const r = emails.BUILDERS[k](ctx({ actionUrl: 'https://x/a', title: 'T', lines: [] }));
    assert.ok(r.subject && typeof r.subject === 'string', k);
    assert.ok(r.html.startsWith('<div'), k);
  }
});
t('welcome: package, HST breakdown, create-password button with fragment link', () => {
  const link = emails.setPasswordUrl('RAWTOKEN', 'invite');
  const r = emails.welcomeSignedEmail(ctx({ actionUrl: link, hasPassword: false, recipientName: 'Jane Doe' }));
  const txt = textOf(r.html);
  assert.match(r.subject, /signed/);
  assert.ok(txt.includes('Dear Jane Doe,'));
  assert.ok(txt.includes('Smart Monitoring'));
  assert.ok(txt.includes('$32.99') && txt.includes('$4.29') && txt.includes('$37.28'));
  assert.ok(txt.includes('Create your password'));
  assert.ok(r.html.includes('/portal/set-password#t=RAWTOKEN'));
  assert.ok(txt.includes('7 days'));
  assert.ok(txt.includes('attached'));
  assert.ok(txt.includes('Genius Smart Home · a Treasure Hill company'));
});
t('welcome log-in variant has no password wording', () => {
  const r = emails.welcomeSignedEmail(ctx({ actionUrl: 'https://x/portal/', hasPassword: true }));
  const txt = textOf(r.html);
  assert.ok(txt.includes('Log in and set up payment'));
  assert.ok(!txt.includes('Create your password'));
  assert.ok(txt.includes('Dear Jane Doe and John Doe,'), 'defaults to every purchaser name');
});
t('nudge links to the portal pay page, never Checkout', () => {
  const r = emails.paymentSetupNudgeEmail(ctx({}));
  assert.ok(r.html.includes(`/portal/pay?contract=${contract._id}`));
  assert.ok(!/checkout\.stripe\.com/.test(r.html));
  assert.ok(textOf(r.html).includes('$37.28'));
});
t('upcoming payment: amount with HST breakdown, card last4, local date', () => {
  const r = emails.upcomingPaymentEmail(ctx({}));
  const txt = textOf(r.html);
  assert.ok(txt.includes("we'll charge $37.28 (Smart Monitoring $32.99 + HST $4.29) to your card ending in 4242 on December 3, 2026"), txt);
  assert.ok(txt.includes('HST (13%)'));
  assert.match(r.subject, /December 3, 2026.*\$37\.28/);
});
t('upcoming payment uses the schedule timezone for the date', () => {
  // 03:30 UTC on Dec 3 is still Dec 2 in Toronto.
  const r = emails.upcomingPaymentEmail(ctx({ chargeDate: new Date('2026-12-03T03:30:00Z'), last4: '1111' }));
  assert.ok(textOf(r.html).includes('on December 2, 2026'));
  assert.ok(textOf(r.html).includes('ending in 1111'));
});
t('receipt: number, period, subtotal, HST, total, links, HST registration #', () => {
  const payment = {
    number: 'ABCD-0001',
    periodStart: new Date('2026-11-03T15:00:00Z'),
    periodEnd: new Date('2026-12-03T15:00:00Z'),
    paidAt: new Date('2026-11-03T15:01:00Z'),
    subtotalCents: 3299,
    taxCents: 429,
    totalCents: 3728,
    amountPaidCents: 3728,
    hostedInvoiceUrl: 'https://invoice.stripe.com/i/abc',
    invoicePdfUrl: 'https://pay.stripe.com/invoice/abc/pdf',
  };
  const r = emails.invoiceReceiptEmail(ctx({ payment, hstRegistrationNumber: '123456789 RT0001' }));
  const txt = textOf(r.html);
  assert.ok(r.subject.includes('ABCD-0001'));
  for (const s of ['ABCD-0001', 'November 3, 2026 to December 3, 2026', '$32.99', '$4.29', '$37.28', 'HST registration number: 123456789 RT0001', 'View invoice', 'Download PDF']) {
    assert.ok(txt.includes(s), s);
  }
  assert.ok(r.html.includes('https://invoice.stripe.com/i/abc'));
  assert.ok(r.html.includes('https://pay.stripe.com/invoice/abc/pdf'));
});
t('payment failed: amount, reason, next retry, update-card link', () => {
  const r = emails.paymentFailedEmail(
    ctx({ payment: { amountDueCents: 3728, amountRemainingCents: 3728, number: 'N-2' }, failureMessage: 'Your card was declined.', nextAttemptAt: new Date('2026-12-06T15:00:00Z') })
  );
  const txt = textOf(r.html);
  assert.ok(txt.includes('$37.28') && txt.includes('N-2'));
  assert.ok(txt.includes('Your card was declined.'));
  assert.ok(txt.includes('December 6, 2026'));
  assert.ok(txt.includes('Update your card'));
});
t('card expiring names the expiry and the next charge', () => {
  const txt = textOf(emails.cardExpiringEmail(ctx({ expMonth: 11, expYear: 2026, chargeDate: contract.billing.currentPeriodEnd })).html);
  assert.ok(txt.includes('card ending in 4242'));
  assert.ok(txt.includes('11/2026'));
  assert.ok(txt.includes('December 3, 2026'));
});
t('password reset: 1 hour wording and fragment link', () => {
  const r = emails.passwordResetEmail({ contract: null, setting, tz: TZ, data: { actionUrl: emails.setPasswordUrl('R', 'reset') } });
  assert.ok(r.html.includes('/portal/reset#t=R'));
  assert.ok(textOf(r.html).includes('1 hour'));
});
t('canceled: end date, and the staff reason is not quoted', () => {
  const r = emails.canceledEmail(ctx({ atPeriodEnd: true, endsAt: new Date('2026-12-03T15:00:00Z'), reason: 'internal remark xyz' }));
  const txt = textOf(r.html);
  assert.ok(txt.includes('December 3, 2026'));
  assert.ok(!txt.includes('internal remark xyz'));
});
t('admin alert: title, lines, link to the admin contract page; HTML escaped', () => {
  const r = emails.adminAlertEmail(ctx({ title: 'Envelope declined', lines: ['Reason: <b>no</b>'], alertKind: 'declined' }));
  assert.match(r.subject, /Envelope declined/);
  assert.ok(r.html.includes(`${env.appUrl}/contracts/${contract._id}`));
  assert.ok(r.html.includes('Reason: &lt;b&gt;no&lt;/b&gt;'));
});
t('user-supplied names are escaped', () => {
  const r = emails.welcomeSignedEmail(ctx({ actionUrl: 'https://x', hasPassword: false, recipientName: '<script>x</script>' }));
  assert.ok(!r.html.includes('<script>'));
});

group('gates + recipients (pure)');
t('isKindEnabled honours the global and per-contract toggles', () => {
  const off = (k, v) => ({ alarm: { ...setting.alarm, [k]: v } });
  assert.strictEqual(emails.isKindEnabled('upcoming_payment', setting, contract), true);
  assert.strictEqual(emails.isKindEnabled('upcoming_payment', off('paymentRemindersEnabled', false), contract), false);
  assert.strictEqual(emails.isKindEnabled('card_expiring', setting, { ...contract, reminders: { enabled: false } }), false);
  assert.strictEqual(emails.isKindEnabled('receipt', off('autoSendInvoices', false), contract), false);
  assert.strictEqual(emails.isKindEnabled('receipt', setting, { ...contract, invoiceEmails: { enabled: false } }), false);
  assert.strictEqual(emails.isKindEnabled('payment_failed', off('sendFailedPaymentEmails', false), contract), false);
  assert.strictEqual(emails.isKindEnabled('welcome', off('paymentRemindersEnabled', false), contract), true);
  assert.strictEqual(emails.isKindEnabled('upcoming_payment', {}, {}), true, 'missing toggles count as on');
});
t('default recipients: primary To, co-buyers CC, internal BCC', () => {
  const r = emails.resolveRecipients({ contract, kind: 'receipt', setting });
  assert.strictEqual(r.to, 'jane@example.com');
  assert.strictEqual(r.cc, 'john@example.com');
  assert.strictEqual(r.bcc, 'contracts@treasurehill.com');
  assert.deepStrictEqual(r.recipients.map((x) => x.role), ['buyer', 'coBuyer']);
});
t('shared inbox gets one copy', () => {
  const c = { ...contract, purchasers: [{ name: 'A', email: 'home@x.com' }, { name: 'B', email: 'HOME@x.com' }] };
  const r = emails.resolveRecipients({ contract: c, kind: 'receipt', setting });
  assert.strictEqual(r.to, 'home@x.com');
  assert.strictEqual(r.cc, '');
});
t('personal-link kinds go to one person with no BCC', () => {
  const r = emails.resolveRecipients({ contract, kind: 'welcome', to: 'john@example.com', setting });
  assert.strictEqual(r.to, 'john@example.com');
  assert.strictEqual(r.cc, '');
  assert.strictEqual(r.bcc, '');
  assert.strictEqual(emails.resolveRecipients({ contract: null, kind: 'password_reset', to: 'a@x.com', setting }).bcc, '');
});
t('admin alerts go to contractsCcEmail, falling back to the owner', () => {
  assert.strictEqual(emails.resolveRecipients({ contract, kind: 'admin_alert', setting }).to, 'contracts@treasurehill.com');
  const noCc = { ...setting, alarm: { ...setting.alarm, contractsCcEmail: '' } };
  const r = emails.resolveRecipients({ contract, kind: 'admin_alert', setting: noCc });
  assert.strictEqual(r.to, 'genius@treasurehill.com');
  assert.strictEqual(r.bcc, '');
});

group('sendContractEmail (stubbed I/O)');
function stub({ smtp = true, fail = false } = {}) {
  const calls = { sent: [], logs: [], events: [] };
  Object.assign(emails._deps, {
    smtpConfigured: () => smtp,
    getSetting: async () => setting,
    sendEmail: async (m) => {
      if (fail) throw new Error('SMTP 550 rejected');
      calls.sent.push(m);
      return { messageId: '<m1@x>' };
    },
    logMessage: async (row) => calls.logs.push(row),
    logContractEvent: async (ev) => calls.events.push(ev),
  });
  return calls;
}
t('sends, logs MessageLog with sendGroup and a ContractEvent', async () => {
  const calls = stub();
  const r = await emails.sendContractEmail({ contract, kind: 'receipt', data: { payment: { totalCents: 3728, subtotalCents: 3299, taxCents: 429 } }, actor: 'stripe' });
  assert.deepStrictEqual(r, { ok: true, messageId: '<m1@x>' });
  assert.strictEqual(calls.sent[0].to, 'jane@example.com');
  assert.strictEqual(calls.sent[0].cc, 'john@example.com');
  assert.strictEqual(calls.sent[0].bcc, 'contracts@treasurehill.com');
  const log = calls.logs[0];
  assert.strictEqual(log.sendGroup, `contract:${contract._id}:receipt`);
  assert.strictEqual(log.type, 'email');
  assert.strictEqual(log.status, 'sent');
  assert.strictEqual(String(log.lot), contract.lot);
  assert.strictEqual(calls.events[0].type, 'invoice_emailed');
  assert.strictEqual(calls.events[0].actor, 'stripe');
});
t('stored copy has the token redacted; the sent email keeps it', async () => {
  const calls = stub();
  const link = emails.setPasswordUrl('LIVE_TOKEN_123', 'invite');
  await emails.sendContractEmail({ contract, kind: 'welcome', to: 'jane@example.com', data: { actionUrl: link, hasPassword: false } });
  assert.ok(calls.sent[0].html.includes('LIVE_TOKEN_123'));
  assert.ok(!calls.logs[0].body.includes('LIVE_TOKEN_123'));
  assert.ok(!JSON.stringify(calls.events).includes('LIVE_TOKEN_123'));
  assert.strictEqual(calls.events[0].type, 'invite_sent');
  assert.strictEqual(calls.sent[0].bcc, undefined);
});
t('gated kinds are skipped unless force', async () => {
  const calls = stub();
  const c = { ...contract, reminders: { enabled: false } };
  assert.deepStrictEqual(await emails.sendContractEmail({ contract: c, kind: 'upcoming_payment' }), { ok: false, skipped: 'disabled' });
  assert.strictEqual(calls.sent.length, 0);
  const forced = await emails.sendContractEmail({ contract: c, kind: 'upcoming_payment', force: true });
  assert.strictEqual(forced.ok, true);
});
t('never throws: SMTP failure → ok:false, failed log + email_failed event', async () => {
  const calls = stub({ fail: true });
  const r = await emails.sendContractEmail({ contract, kind: 'canceled', data: { atPeriodEnd: false } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /550/);
  assert.strictEqual(calls.logs[0].status, 'failed');
  assert.strictEqual(calls.events[0].type, 'email_failed');
});
t('no SMTP / no recipient / unknown kind are reported, not thrown', async () => {
  stub({ smtp: false });
  assert.deepStrictEqual(await emails.sendContractEmail({ contract, kind: 'canceled' }), { ok: false, skipped: 'smtp_not_configured' });
  stub();
  assert.deepStrictEqual(await emails.sendContractEmail({ contract: { ...contract, purchasers: [] }, kind: 'canceled' }), { ok: false, skipped: 'no_recipient' });
  const r = await emails.sendContractEmail({ contract, kind: 'nope' });
  assert.strictEqual(r.ok, false);
});
t('sendAdminAlert works without a contract', async () => {
  const calls = stub();
  const r = await emails.sendAdminAlert({ alertKind: 'catalog_mismatch', title: 'Stripe catalog mismatch', lines: ['basic price differs'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.sent[0].to, 'contracts@treasurehill.com');
  assert.strictEqual(calls.logs[0].sendGroup, 'contract:none:admin_alert');
  assert.strictEqual(calls.events.length, 0);
});

module.exports = done();

/**
 * Contracts dashboard math (services/contracts/metrics pure helpers) and the
 * admin route's input cleaning. No DB, no network: every helper here takes
 * plain objects.
 */
const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const m = require('../contracts/metrics');
const routes = require('../../routes/contracts');

const NOW = new Date('2026-10-28T15:00:00Z');
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
const smart = { unitCents: 3299, taxBps: 1300, taxCents: 429, totalCents: 3728, currency: 'cad' };
const basic = { unitCents: 2499, taxBps: 1300, taxCents: 325, totalCents: 2824, currency: 'cad' };
const P1 = '64b000000000000000000001';
const P2 = '64b000000000000000000002';

function contract(over = {}) {
  return {
    _id: over._id || `c${Math.random().toString(16).slice(2, 8)}`,
    number: 'GA-2026-00001',
    status: 'draft',
    needsAttention: '',
    project: P1,
    property: { projectName: 'Sereno', lotNumber: '0006' },
    purchasers: [{ role: 'buyer', name: 'Ann', email: 'ann@x.com' }],
    package: null,
    pricing: {},
    billing: {},
    envelope: {},
    createdAt: days(-30),
    ...over,
  };
}

group('parseDateOnly');
t('YYYY-MM-DD → 12:00 UTC that day', () => {
  assert.strictEqual(m.parseDateOnly('2026-11-03').toISOString(), '2026-11-03T12:00:00.000Z');
});
t('ISO timestamps keep their UTC calendar day', () => {
  assert.strictEqual(m.parseDateOnly('2026-11-03T23:30:00Z').toISOString(), '2026-11-03T12:00:00.000Z');
});
t('blank → null, garbage and rollovers → undefined', () => {
  assert.strictEqual(m.parseDateOnly(''), null);
  assert.strictEqual(m.parseDateOnly(null), null);
  assert.strictEqual(m.parseDateOnly('nope'), undefined);
  assert.strictEqual(m.parseDateOnly('2026-02-31'), undefined);
});

group('months + next charge');
t('monthsActive counts from billing.startedAt to endedAt or now', () => {
  assert.strictEqual(m.monthsActiveFor(contract({ billing: { startedAt: new Date('2026-01-31T12:00:00Z') } }), NOW), 8);
  assert.strictEqual(
    m.monthsActiveFor(contract({ billing: { startedAt: new Date('2026-01-15Z'), endedAt: new Date('2026-04-14Z') } }), NOW),
    2
  );
  assert.strictEqual(m.monthsActiveFor(contract({ signedAt: days(-90) }), NOW), 0, 'awaiting payment has no billing duration');
});
t('next charge only for renewing active / past_due subscriptions', () => {
  const end = days(3);
  assert.strictEqual(m.nextChargeFor(contract({ status: 'active', billing: { currentPeriodEnd: end } })).getTime(), end.getTime());
  assert.strictEqual(m.nextChargeFor(contract({ status: 'active', billing: { currentPeriodEnd: end, cancelAtPeriodEnd: true } })), null);
  assert.strictEqual(m.nextChargeFor(contract({ status: 'unpaid', billing: { currentPeriodEnd: end } })), null);
  assert.strictEqual(m.nextChargeFor(contract({ status: 'canceled', billing: { currentPeriodEnd: end } })), null);
});

group('chart');
t('12 months, oldest first, ending with the current month', () => {
  const keys = m.monthKeys(NOW, 12);
  assert.strictEqual(keys.length, 12);
  assert.strictEqual(keys[0], '2025-11');
  assert.strictEqual(keys[11], '2026-10');
});
t('rows are placed by month and kind; gaps are zero; out-of-range rows dropped', () => {
  const chart = m.buildChart(
    [
      { month: '2026-10', kind: 'paid', cents: 3728, count: 1 },
      { month: '2026-10', kind: 'paid', cents: 2824, count: 1 },
      { month: '2026-09', kind: 'failed', cents: 3728, count: 1 },
      { month: '2024-01', kind: 'paid', cents: 999, count: 1 },
    ],
    NOW
  );
  assert.strictEqual(chart.length, 12);
  assert.deepStrictEqual(chart[11], { month: '2026-10', paidCents: 6552, paidCount: 2, failedCents: 0, failedCount: 0 });
  assert.deepStrictEqual(chart[10], { month: '2026-09', paidCents: 0, paidCount: 0, failedCents: 3728, failedCount: 1 });
  assert.strictEqual(chart.reduce((n, x) => n + x.paidCents, 0), 6552);
});

group('computeSummary');
const fleet = [
  contract({ status: 'draft' }),
  contract({ status: 'sent', envelope: { sentAt: days(-10) } }),
  contract({ status: 'sent', envelope: { sentAt: days(-2) } }),
  contract({ status: 'awaiting_payment', signedAt: days(-9), package: 'smart', pricing: smart }),
  contract({ status: 'awaiting_payment', signedAt: days(-1), package: 'basic', pricing: basic, needsAttention: '' }),
  contract({ status: 'awaiting_payment', signedAt: days(-1), needsAttention: 'package_missing' }),
  contract({
    status: 'active',
    package: 'smart',
    pricing: smart,
    billing: { startedAt: new Date('2026-04-28T12:00:00Z'), currentPeriodEnd: days(5) },
  }),
  contract({
    status: 'active',
    package: 'basic',
    pricing: basic,
    project: P2,
    billing: { startedAt: new Date('2026-08-28T12:00:00Z'), currentPeriodEnd: days(20) },
  }),
  contract({ status: 'past_due', package: 'smart', pricing: smart, billing: { startedAt: new Date('2026-07-28T12:00:00Z'), currentPeriodEnd: days(2) } }),
  contract({ status: 'unpaid', package: 'basic', pricing: basic, billing: { startedAt: new Date('2026-05-28T12:00:00Z') } }),
  contract({
    status: 'canceled',
    package: 'smart',
    pricing: smart,
    billing: { startedAt: new Date('2026-01-28T12:00:00Z'), endedAt: new Date('2026-03-28T12:00:00Z') },
  }),
];
const sum = m.computeSummary(fleet, { now: NOW, projectNames: new Map([[P1, 'Sereno'], [P2, 'Union Village']]) });

t('counts every status plus needsAttention and total', () => {
  assert.strictEqual(sum.counts.total, 11);
  assert.strictEqual(sum.counts.draft, 1);
  assert.strictEqual(sum.counts.sent, 2);
  assert.strictEqual(sum.counts.awaiting_payment, 3);
  assert.strictEqual(sum.counts.active, 2);
  assert.strictEqual(sum.counts.past_due, 1);
  assert.strictEqual(sum.counts.unpaid, 1);
  assert.strictEqual(sum.counts.canceled, 1);
  assert.strictEqual(sum.counts.declined, 0);
  assert.strictEqual(sum.counts.needsAttention, 1);
});
t('MRR is pre-tax over active + past_due + unpaid; incl. tax separately', () => {
  assert.strictEqual(sum.mrrCents, 3299 + 2499 + 3299 + 2499);
  assert.strictEqual(sum.mrrInclTaxCents, 3728 + 2824 + 3728 + 2824);
});
t('package mix counts paying contracts only', () => {
  assert.deepStrictEqual(sum.packageMix, { basic: 2, smart: 2 });
});
t('avg months active over every contract that started billing', () => {
  // 6, 2, 3, 5, 2 → 3.6
  assert.strictEqual(sum.avgMonthsActive, 3.6);
});
t('pipeline: oldest unsigned envelope age; stale = signed > 7 days ago', () => {
  assert.deepStrictEqual(sum.awaitingSignature, { count: 2, oldestDays: 10 });
  assert.deepStrictEqual(sum.awaitingPayment, { count: 3, staleCount: 1 });
});
t('upcoming 7 days: renewing subscriptions, incl. tax', () => {
  assert.deepStrictEqual(sum.upcoming7d, { count: 2, cents: 3728 + 3728 });
});
t('per project: active, total, MRR, named from the project list', () => {
  const p1 = sum.byProject.find((p) => p.projectId === P1);
  const p2 = sum.byProject.find((p) => p.projectId === P2);
  assert.strictEqual(p1.name, 'Sereno');
  assert.strictEqual(p1.total, 10);
  assert.strictEqual(p1.active, 1);
  assert.strictEqual(p1.mrrCents, 3299 + 3299 + 2499);
  assert.deepStrictEqual({ name: p2.name, total: p2.total, active: p2.active, mrrCents: p2.mrrCents }, { name: 'Union Village', total: 1, active: 1, mrrCents: 2499 });
  assert.strictEqual(sum.byProject[0].projectId, P1, 'largest project first');
});
t('empty input gives zeros, not NaN', () => {
  const z = m.computeSummary([], { now: NOW });
  assert.strictEqual(z.counts.total, 0);
  assert.strictEqual(z.avgMonthsActive, 0);
  assert.strictEqual(z.mrrCents, 0);
  assert.deepStrictEqual(z.awaitingSignature, { count: 0, oldestDays: 0 });
});

group('alerts');
t('package missing, card expiring within 30 days, completion stuck > 1h', () => {
  const alerts = m.contractAlerts(
    [
      contract({ number: 'GA-1', status: 'awaiting_payment', needsAttention: 'package_missing' }),
      contract({ number: 'GA-2', status: 'active', billing: { pmExpMonth: 10, pmExpYear: 2026, pmLast4: '4242' } }),
      contract({ number: 'GA-3', status: 'active', billing: { pmExpMonth: 12, pmExpYear: 2027, pmLast4: '4242' } }),
      contract({ number: 'GA-4', status: 'active', billing: { pmExpMonth: 10, pmExpYear: 2026, cancelAtPeriodEnd: true } }),
      contract({ number: 'GA-5', status: 'awaiting_payment', envelope: { status: 'completed', completedAt: days(-1), completionDoneAt: null } }),
      contract({ number: 'GA-6', status: 'awaiting_payment', envelope: { status: 'completed', completedAt: new Date(NOW.getTime() - 10 * 60 * 1000) } }),
      contract({ number: 'GA-7', status: 'awaiting_payment', envelope: { status: 'completed', completedAt: days(-1), completionDoneAt: days(-1) } }),
    ],
    NOW
  );
  assert.deepStrictEqual(
    alerts.map((a) => `${a.kind}:${a.number}`),
    ['package_missing:GA-1', 'card_expiring:GA-2', 'completion_stuck:GA-5']
  );
  assert.ok(alerts[1].message.includes('4242'));
});

group('table rows + filters');
t('toRow flattens a populated contract', () => {
  const r = m.toRow(
    contract({
      _id: 'x1',
      number: 'GA-2026-00042',
      status: 'past_due',
      project: { _id: P1, name: 'Sereno' },
      lot: { _id: 'l1', lotNumber: '0006' },
      purchasers: [{ name: 'Ann', email: 'ann@x.com' }, { name: '', email: '' }, { name: 'Bob', email: 'ann@x.com' }],
      package: 'smart',
      pricing: smart,
      reminders: { enabled: false },
      billing: { startedAt: new Date('2026-07-28T12:00:00Z'), currentPeriodEnd: days(2), paidCount: 2, totalPaidCents: 7456, missedCount: 1, consecutiveMissed: 1, missedOpenCents: 3728 },
    }),
    NOW
  );
  assert.strictEqual(r.project.name, 'Sereno');
  assert.strictEqual(r.lot.lotNumber, '0006');
  assert.strictEqual(r.purchasers.length, 2);
  assert.strictEqual(r.totalCents, 3728);
  assert.strictEqual(r.monthsActive, 3);
  assert.strictEqual(r.missedCount, 1);
  assert.strictEqual(r.remindersEnabled, false);
  assert.strictEqual(r.invoiceEmailsEnabled, true);
  assert.strictEqual(r.nextChargeAt.getTime(), days(2).getTime());
});
t('toRow falls back to the property snapshot when not populated', () => {
  const r = m.toRow(contract({ project: P1, lot: 'l1' }), NOW);
  assert.strictEqual(r.project.name, 'Sereno');
  assert.strictEqual(r.lot.lotNumber, '0006');
  assert.strictEqual(r.unitCents, null);
});
t('default filter: current contracts only', () => {
  assert.deepStrictEqual(m.buildListFilter({}, NOW), { isCurrent: true });
  assert.deepStrictEqual(m.buildListFilter({ current: '0' }, NOW), {});
});
t('status / project lists, unknown values dropped', () => {
  const f = m.buildListFilter({ status: 'active,past_due,bogus', project: `${P1},nope` }, NOW);
  assert.deepStrictEqual(f.status, { $in: ['active', 'past_due'] });
  assert.strictEqual(f.project, P1);
  assert.strictEqual(m.buildListFilter({ status: ['sent'] }, NOW).status, 'sent');
});
t('due=7d narrows to renewing subscriptions in the window', () => {
  const f = m.buildListFilter({ due: '7d' }, NOW);
  assert.deepStrictEqual(f.status, { $in: ['active', 'past_due'] });
  assert.deepStrictEqual(f['billing.cancelAtPeriodEnd'], { $ne: true });
  assert.strictEqual(f['billing.currentPeriodEnd'].$gte.getTime(), NOW.getTime());
  assert.strictEqual(f['billing.currentPeriodEnd'].$lte.getTime(), days(7).getTime());
  assert.deepStrictEqual(m.buildListFilter({ due: '7d', status: 'draft' }, NOW).status, { $in: [] });
});
t('reminders / needsAttention / missed / q', () => {
  assert.strictEqual(m.buildListFilter({ reminders: 'off' }, NOW)['reminders.enabled'], false);
  assert.deepStrictEqual(m.buildListFilter({ reminders: 'on' }, NOW)['reminders.enabled'], { $ne: false });
  assert.deepStrictEqual(m.buildListFilter({ needsAttention: '1' }, NOW).needsAttention, { $nin: ['', null] });
  assert.deepStrictEqual(m.buildListFilter({ missed: '1' }, NOW)['billing.missedCount'], { $gt: 0 });
  const q = m.buildListFilter({ q: 'a.b(' }, NOW).$or;
  assert.ok(q.length >= 5);
  assert.ok(q[0].number.test('xA.B(y'), 'regex-escaped, case-insensitive');
  assert.ok(!q[0].number.test('axb('));
});
t('sort whitelist with stable _id tiebreak', () => {
  assert.deepStrictEqual(m.sortSpec(), { createdAt: -1, _id: -1 });
  assert.deepStrictEqual(m.sortSpec('nextCharge'), { 'billing.currentPeriodEnd': 1, _id: 1 });
  assert.deepStrictEqual(m.sortSpec('-missed'), { 'billing.missedCount': -1, 'billing.consecutiveMissed': -1, _id: -1 });
  assert.deepStrictEqual(m.sortSpec('$where'), { createdAt: -1, _id: -1 });
});
t('paging is clamped', () => {
  assert.deepStrictEqual(m.pageParams({}), { limit: 50, page: 1, skip: 0 });
  assert.deepStrictEqual(m.pageParams({ limit: '5000', page: '3' }), { limit: 200, page: 3, skip: 400 });
  assert.deepStrictEqual(m.pageParams({ limit: '-1', page: '0' }), { limit: 1, page: 1, skip: 0 });
});

group('CSV');
t('cells: quoting, dates, formula injection', () => {
  assert.strictEqual(m.csvCell('plain'), 'plain');
  assert.strictEqual(m.csvCell('a,b'), '"a,b"');
  assert.strictEqual(m.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(m.csvCell(new Date('2026-11-03T12:00:00Z')), '2026-11-03');
  assert.strictEqual(m.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(m.csvCell('-12.50'), '-12.50');
  assert.strictEqual(m.csvCell(null), '');
  assert.strictEqual(m.csvCell(0), '0');
});
t('header + one line per row, dollars with 2 decimals', () => {
  const row = m.toRow(contract({ number: 'GA-2026-00042', status: 'active', package: 'smart', pricing: smart, purchasers: [{ name: 'Ann, Jr', email: 'a@x.com' }] }), NOW);
  const csv = m.rowsToCsv([row]);
  const lines = csv.trimEnd().split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].startsWith('Contract,Status,'));
  assert.ok(lines[1].startsWith('GA-2026-00042,active,,"Ann, Jr",a@x.com,Sereno,0006,smart,32.99,37.28,'));
  assert.strictEqual(m.rowsToCsv([]).split('\r\n').filter(Boolean).length, 1);
});

group('contractSummary (lot card)');
t('actions follow the status guards; documents carry no data', () => {
  const s = m.contractSummary(contract({ status: 'draft', signingMode: 'remote' }), {
    documents: [{ _id: 'd1', kind: 'agreement_unsigned', size: 10, sha256: 'ab', data: Buffer.from('x') }],
    events: [{ _id: 'e1', type: 'created', message: 'hi', meta: { secret: 1 } }],
    now: NOW,
  });
  assert.strictEqual(s.actions.send, true);
  assert.strictEqual(s.actions.cancel, false);
  assert.strictEqual(s.documents[0].data, undefined);
  assert.strictEqual(s.events[0].meta, undefined);
  assert.strictEqual(m.contractSummary(null), null);
});

t('past-due strip: failure reason and next retry from the open invoice', () => {
  const c = contract({ status: 'past_due' });
  c.billing = { ...(c.billing || {}), status: 'past_due', lastFailureMessage: 'Older reason' };
  const retry = new Date('2026-11-02T15:00:00Z');
  const s = m.contractSummary(c, { openPayment: { failureMessage: 'Your card was declined.', nextPaymentAttempt: retry }, now: NOW });
  assert.strictEqual(s.billing.lastFailureMessage, 'Your card was declined.');
  assert.strictEqual(s.billing.nextPaymentAttempt, retry);
  const bare = m.contractSummary(c, { now: NOW });
  assert.strictEqual(bare.billing.lastFailureMessage, 'Older reason');
  assert.strictEqual(bare.billing.nextPaymentAttempt, null);
});

group('route input cleaning');
t('purchasers: roles assigned in order, emails lowercased', () => {
  const ps = routes.cleanPurchasers([{ name: ' Ann ', email: 'ANN@X.com ' }, { name: 'Bob', email: 'ann@x.com', role: 'buyer' }], { signingMode: 'remote' });
  assert.deepStrictEqual(ps.map((p) => p.role), ['buyer', 'coBuyer']);
  assert.strictEqual(ps[0].email, 'ann@x.com');
  assert.strictEqual(ps[0].name, 'Ann');
  assert.strictEqual(ps[1].email, 'ann@x.com', 'a shared inbox is allowed');
});
t('purchasers: signers need a valid email except on paper', () => {
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return `${e.code}:${e.field}`;
    }
    return 'ok';
  };
  assert.strictEqual(code(() => routes.cleanPurchasers([{ name: 'Ann' }], { signingMode: 'remote' })), 'validation_failed:purchasers.0.email');
  assert.strictEqual(code(() => routes.cleanPurchasers([{ name: 'Ann' }], { signingMode: 'paper' })), 'ok');
  assert.strictEqual(code(() => routes.cleanPurchasers([{ name: 'Ann', signs: false }], { signingMode: 'remote' })), 'ok');
  assert.strictEqual(code(() => routes.cleanPurchasers([{ name: 'Ann', email: 'nope' }], { signingMode: 'paper' })), 'validation_failed:purchasers.0.email');
  assert.strictEqual(code(() => routes.cleanPurchasers([], {})), 'validation_failed:purchasers');
  assert.strictEqual(code(() => routes.cleanPurchasers([{ email: 'a@x.com' }], {})), 'validation_failed:purchasers.0.name');
  assert.strictEqual(
    code(() => routes.cleanPurchasers([1, 2, 3, 4].map((i) => ({ name: `P${i}`, email: `p${i}@x.com` })), {})),
    'validation_failed:purchasers'
  );
});
t('property: only given fields; closing date is date-only', () => {
  assert.deepStrictEqual(routes.cleanProperty({ model: ' A3END A ' }), { model: 'A3END A' });
  assert.strictEqual(routes.cleanProperty({ closingDate: '2026-11-03' }).closingDate.toISOString(), '2026-11-03T12:00:00.000Z');
  assert.throws(() => routes.cleanProperty({ closingDate: 'soon' }), (e) => e.code === 'validation_failed');
});
t('save to lot keeps each buyer\'s marketing opt-out', () => {
  const buyers = routes.purchasersToBuyers(
    [{ role: 'buyer', name: 'Ann', email: 'ann@x.com', phone: '' }, { role: 'coBuyer', name: 'Bob', email: 'bob@x.com', phone: '' }],
    [{ role: 'buyer', name: 'Ann', email: 'ann@x.com', optedOut: true }]
  );
  assert.deepStrictEqual(buyers.map((b) => b.optedOut), [true, false]);
});

module.exports = done();

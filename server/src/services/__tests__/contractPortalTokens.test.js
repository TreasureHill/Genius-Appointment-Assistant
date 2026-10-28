const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const pt = require('../contracts/portalTokens');

// Portal accounts and their single-use links. No database: a tiny in-memory
// PortalUser stands in, supporting exactly the query shapes portalTokens uses
// (equality, $in, $gt, $ne; $set, $inc, $setOnInsert, $addToSet, upsert).

function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('$in' in cond && !cond.$in.some((x) => String(x) === String(v))) return false;
      if ('$gt' in cond && !(v != null && v > cond.$gt)) return false;
      if ('$ne' in cond && v === cond.$ne) return false;
      return true;
    }
    return String(v) === String(cond);
  });
}

function fakePortalUser() {
  const rows = [];
  let seq = 0;
  const apply = (doc, update, inserting) => {
    if (inserting && update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
    if (update.$set) Object.assign(doc, update.$set);
    for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
    for (const [k, v] of Object.entries(update.$addToSet || {})) {
      doc[k] = doc[k] || [];
      if (!doc[k].some((x) => String(x) === String(v))) doc[k].push(v);
    }
  };
  return {
    rows,
    add(fields) {
      const doc = { _id: `u${++seq}`, email: '', name: '', passwordHash: '', contracts: [], tokenHash: null, tokenPurpose: null, tokenExpiresAt: null, tokenVersion: 0, disabled: false, ...fields };
      rows.push(doc);
      return doc;
    },
    async findOne(filter) {
      const d = rows.find((r) => matches(r, filter));
      return d ? { ...d } : null;
    },
    async updateOne(filter, update) {
      const d = rows.find((r) => matches(r, filter));
      if (d) apply(d, update, false);
      return { modifiedCount: d ? 1 : 0 };
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      let d = rows.find((r) => matches(r, filter));
      if (!d && opts.upsert) {
        d = this.add({});
        apply(d, update, true);
        return { ...d };
      }
      if (!d) return null;
      apply(d, update, false);
      return { ...d };
    },
  };
}

let clock = new Date('2026-11-02T15:00:00Z');
let PU = fakePortalUser();
pt._deps.PortalUser = () => PU;
pt._deps.now = () => clock;
const reset = () => {
  PU = fakePortalUser();
  clock = new Date('2026-11-02T15:00:00Z');
};

group('pure helpers');
t('generateToken is 43-char base64url and unique', () => {
  const a = pt.generateToken();
  const b = pt.generateToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(a, b);
});
t('hashToken is sha256 hex and deterministic', () => {
  assert.match(pt.hashToken('abc'), /^[0-9a-f]{64}$/);
  assert.strictEqual(pt.hashToken('abc'), pt.hashToken('abc'));
  assert.notStrictEqual(pt.hashToken('abc'), pt.hashToken('abd'));
});
t('maskEmail keeps the first letter and the domain', () => {
  assert.strictEqual(pt.maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.strictEqual(pt.maskEmail('nope'), '');
});
t('TTLs: invite 7 days, reset 1 hour', () => {
  assert.strictEqual(pt.INVITE_TTL_MS, 7 * 86400000);
  assert.strictEqual(pt.RESET_TTL_MS, 3600000);
});
t('assertPasswordOk: < 10 chars is weak_password, > 200 validation_failed', () => {
  assert.throws(() => pt.assertPasswordOk('short'), (e) => e.code === 'weak_password' && e.status === 400);
  assert.throws(() => pt.assertPasswordOk(undefined), (e) => e.code === 'weak_password');
  assert.throws(() => pt.assertPasswordOk('x'.repeat(201)), (e) => e.code === 'validation_failed');
  assert.strictEqual(pt.assertPasswordOk('long enough!'), 'long enough!');
});
t('portalAccountsFor: one account per unique email, shared inbox joins names', () => {
  const accounts = pt.portalAccountsFor({
    purchasers: [
      { name: 'Jane Doe', email: 'Home@Example.com' },
      { name: 'John Doe', email: 'home@example.com' },
      { name: 'Third', email: '' },
      { name: 'Kim Lee', email: 'kim@example.com' },
    ],
  });
  assert.deepStrictEqual(accounts, [
    { email: 'home@example.com', name: 'Jane Doe and John Doe' },
    { email: 'kim@example.com', name: 'Kim Lee' },
  ]);
});
t('portalAccountsFor skips non-signers unless nobody signs', () => {
  assert.deepStrictEqual(
    pt.portalAccountsFor({ purchasers: [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com', signs: false }] }).map((a) => a.email),
    ['a@x.com']
  );
  assert.deepStrictEqual(pt.portalAccountsFor({ purchasers: [{ name: 'B', email: 'b@x.com', signs: false }] }).map((a) => a.email), ['b@x.com']);
});

group('passwords');
t('hashPassword / verifyPassword round trip; no password → false', async () => {
  const h = await pt.hashPassword('correct horse battery');
  assert.ok(h.startsWith('$2'));
  assert.strictEqual(await pt.verifyPassword({ passwordHash: h }, 'correct horse battery'), true);
  assert.strictEqual(await pt.verifyPassword({ passwordHash: h }, 'wrong password!!'), false);
  assert.strictEqual(await pt.verifyPassword({ passwordHash: '' }, 'anything at all'), false);
  assert.strictEqual(await pt.verifyPassword(null, 'anything at all'), false);
});

group('tokens');
t('issueToken stores only the hash, with the right purpose and expiry', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  const raw = await pt.issueToken(u, 'invite');
  const row = PU.rows[0];
  assert.strictEqual(row.tokenHash, pt.hashToken(raw));
  assert.ok(!JSON.stringify(row).includes(raw), 'raw token must not be stored');
  assert.strictEqual(row.tokenPurpose, 'invite');
  assert.strictEqual(row.tokenExpiresAt.getTime(), clock.getTime() + pt.INVITE_TTL_MS);
  const r2 = await pt.issueToken(u, 'reset');
  assert.strictEqual(PU.rows[0].tokenExpiresAt.getTime(), clock.getTime() + pt.RESET_TTL_MS);
  // the new token replaces the old one
  assert.strictEqual((await pt.peekToken(raw)).valid, false);
  assert.strictEqual((await pt.peekToken(r2)).valid, true);
});
t('issueToken rejects an unknown purpose', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  await assert.rejects(() => pt.issueToken(u, 'admin'), (e) => e.code === 'validation_failed');
});
t('peekToken reports purpose + masked email without consuming', async () => {
  reset();
  const u = PU.add({ email: 'jane@example.com' });
  const raw = await pt.issueToken(u, 'invite');
  const r = await pt.peekToken(raw);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.purpose, 'invite');
  assert.strictEqual(r.emailMasked, 'j***@example.com');
  assert.strictEqual((await pt.peekToken(raw, 'reset')).valid, false, 'wrong purpose');
  assert.strictEqual((await pt.peekToken(raw)).valid, true, 'still valid after peeking');
  assert.strictEqual((await pt.peekToken('')).valid, false);
  assert.strictEqual((await pt.peekToken({ $ne: null })).valid, false, 'non-string token');
});
t('consumeToken sets the password, clears the token, bumps tokenVersion — single use', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com', failedLogins: 4 });
  const raw = await pt.issueToken(u, 'invite');
  const after = await pt.consumeToken(raw, 'invite', 'a strong password');
  assert.strictEqual(after.tokenVersion, 1);
  assert.strictEqual(after.tokenHash, null);
  assert.strictEqual(after.failedLogins, 0);
  assert.strictEqual(await pt.verifyPassword(after, 'a strong password'), true);
  await assert.rejects(() => pt.consumeToken(raw, 'invite', 'another password'), (e) => e.code === 'invalid_token');
});
t('consumeToken: expired link is invalid_token', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  const raw = await pt.issueToken(u, 'reset');
  clock = new Date(clock.getTime() + pt.RESET_TTL_MS + 1000);
  await assert.rejects(() => pt.consumeToken(raw, 'reset', 'a strong password'), (e) => e.code === 'invalid_token');
});
t('consumeToken: wrong purpose rejected, list of purposes accepted', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  const raw = await pt.issueToken(u, 'invite');
  await assert.rejects(() => pt.consumeToken(raw, 'reset', 'a strong password'), (e) => e.code === 'invalid_token');
  const ok = await pt.consumeToken(raw, ['reset', 'invite'], 'a strong password');
  assert.strictEqual(ok.email, 'a@x.com');
});
t('consumeToken: weak password is refused before the token is touched', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  const raw = await pt.issueToken(u, 'invite');
  await assert.rejects(() => pt.consumeToken(raw, 'invite', 'short'), (e) => e.code === 'weak_password');
  assert.strictEqual((await pt.peekToken(raw)).valid, true);
});
t('consumeToken: disabled users cannot use a link', async () => {
  reset();
  const u = PU.add({ email: 'a@x.com' });
  const raw = await pt.issueToken(u, 'invite');
  PU.rows[0].disabled = true;
  await assert.rejects(() => pt.consumeToken(raw, 'invite', 'a strong password'), (e) => e.code === 'invalid_token');
});

group('portal users');
t('upsertPortalUsersForContract: one user per email, contract linked once', async () => {
  reset();
  PU.add({ email: 'kim@example.com', name: 'Kim', contracts: ['c0'] });
  const contract = {
    _id: 'c1',
    purchasers: [
      { name: 'Jane Doe', email: 'home@example.com' },
      { name: 'John Doe', email: 'HOME@example.com' },
      { name: 'Kim Lee', email: 'kim@example.com' },
    ],
  };
  const users = await pt.upsertPortalUsersForContract(contract);
  assert.strictEqual(users.length, 2);
  await pt.upsertPortalUsersForContract(contract); // replay
  assert.strictEqual(PU.rows.length, 2);
  const kim = PU.rows.find((r) => r.email === 'kim@example.com');
  assert.deepStrictEqual(kim.contracts, ['c0', 'c1']);
  assert.strictEqual(kim.name, 'Kim', 'existing name kept');
  const home = PU.rows.find((r) => r.email === 'home@example.com');
  assert.strictEqual(home.name, 'Jane Doe and John Doe');
  assert.deepStrictEqual(home.contracts, ['c1']);
});

group('inviteContractUsers');
function fakeContracts(contract) {
  const doc = JSON.parse(JSON.stringify(contract));
  const q = (v) => ({ lean: async () => v, sort() { return this; } });
  return {
    doc,
    findById: () => q(doc),
    findOneAndUpdate(filter, update) {
      const ok = filter['portal.invitedAt'] === null ? !doc.portal.invitedAt : true;
      if (ok) Object.assign(doc.portal, { invitedAt: update.$set['portal.invitedAt'] });
      return q(ok ? { _id: doc._id } : null);
    },
    async updateOne(filter, update) {
      for (const [k, v] of Object.entries(update.$inc || {})) doc.portal[k.replace('portal.', '')] = (doc.portal[k.replace('portal.', '')] || 0) + v;
      for (const [k, v] of Object.entries(update.$set || {})) if (k.startsWith('portal.')) doc.portal[k.replace('portal.', '')] = v;
      return { modifiedCount: 1 };
    },
  };
}
function setupInvite({ sendOk = true, contract: over = {} } = {}) {
  reset();
  const contract = {
    _id: 'c9',
    number: 'GA-2026-00009',
    status: 'awaiting_payment',
    package: 'smart',
    needsAttention: '',
    documents: { signed: 'd1' },
    portal: { invitedAt: null, inviteCount: 0 },
    purchasers: [
      { name: 'Jane Doe', email: 'jane@example.com' },
      { name: 'Kim Lee', email: 'kim@example.com' },
    ],
    ...over,
  };
  PU.add({ email: 'kim@example.com', name: 'Kim Lee', passwordHash: '$2a$12$existing', contracts: ['c1'] });
  const AC = fakeContracts(contract);
  const sent = [];
  pt._deps.AlarmContract = () => AC;
  pt._deps.ContractDocument = () => ({
    findOne: () => ({ sort() { return this; }, lean: async () => ({ data: Buffer.from('%PDF-1.7 signed'), contentType: 'application/pdf' }) }),
  });
  pt._deps.logContractEvent = async () => null;
  const realEmails = require('../contracts/emails');
  pt._deps.emails = () => ({
    portalUrl: realEmails.portalUrl,
    setPasswordUrl: realEmails.setPasswordUrl,
    sendContractEmail: async (a) => {
      sent.push(a);
      return sendOk ? { ok: true, messageId: 'm' } : { ok: false, error: 'smtp down' };
    },
  });
  return { AC, sent };
}
t('one personal welcome per user, PDF attached, claimed once', async () => {
  const { AC, sent } = setupInvite();
  const r = await pt.inviteContractUsers({ _id: 'c9' }, { actor: 'docusign' });
  assert.strictEqual(r.sent, 2);
  assert.strictEqual(sent.length, 2);
  const jane = sent.find((s) => s.to === 'jane@example.com');
  const kim = sent.find((s) => s.to === 'kim@example.com');
  assert.strictEqual(jane.kind, 'welcome');
  assert.strictEqual(jane.data.hasPassword, false);
  assert.match(jane.data.actionUrl, /\/portal\/set-password#t=[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(kim.data.hasPassword, true, 'existing account gets the log-in variant');
  assert.ok(!/#t=/.test(kim.data.actionUrl));
  assert.match(kim.data.actionUrl, /\/portal\/pay\?contract=c9$/);
  assert.strictEqual(jane.attachments[0].filename, 'GA-2026-00009-signed.pdf');
  assert.ok(Buffer.isBuffer(jane.attachments[0].content));
  assert.ok(AC.doc.portal.invitedAt);
  assert.strictEqual(AC.doc.portal.inviteCount, 1);
  const again = await pt.inviteContractUsers({ _id: 'c9' });
  assert.deepStrictEqual(again, { sent: 0, skipped: 'already_invited', results: [] });
  assert.strictEqual(sent.length, 2);
});
t('force resends with a fresh token', async () => {
  const { sent } = setupInvite();
  await pt.inviteContractUsers({ _id: 'c9' });
  const firstLink = sent[0].data.actionUrl;
  const r = await pt.inviteContractUsers({ _id: 'c9' }, { force: true, user: 'admin' });
  assert.strictEqual(r.sent, 2);
  const second = sent.filter((s) => s.to === sent[0].to)[1];
  assert.notStrictEqual(second.data.actionUrl, firstLink);
  const oldRaw = decodeURIComponent(firstLink.split('#t=')[1]);
  assert.strictEqual((await pt.peekToken(oldRaw)).valid, false, 'old invite link no longer works');
});
t('package missing → nothing sent, no claim', async () => {
  const { AC, sent } = setupInvite({ contract: { package: null, needsAttention: 'package_missing' } });
  const r = await pt.inviteContractUsers({ _id: 'c9' });
  assert.strictEqual(r.skipped, 'package_missing');
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(AC.doc.portal.invitedAt, null);
});
t('every send failing releases the claim so a retry can send', async () => {
  const { AC } = setupInvite({ sendOk: false });
  const r = await pt.inviteContractUsers({ _id: 'c9' });
  assert.strictEqual(r.sent, 0);
  assert.ok(r.results.every((x) => !x.ok && x.error === 'smtp down'));
  assert.strictEqual(AC.doc.portal.invitedAt, null);
  assert.strictEqual(AC.doc.portal.inviteFailures, 1, 'counted for the retry backoff');
});
t('a later successful send resets the failure count', async () => {
  const { AC } = setupInvite({ contract: { portal: { invitedAt: null, inviteCount: 0, inviteFailures: 2 } } });
  const r = await pt.inviteContractUsers({ _id: 'c9' });
  assert.strictEqual(r.sent, 2);
  assert.strictEqual(AC.doc.portal.inviteFailures, 0);
  assert.strictEqual(AC.doc.portal.lastInviteFailureAt, null);
});

group('contract tail worker: welcome retry backoff (pure)');
t('due at once without failures, then backs off 15 min doubling to 6 h, stops at the cap', () => {
  const w = require('../../workers/contractTailWorker');
  const now = new Date('2026-10-01T12:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60 * 1000);
  assert.strictEqual(w.inviteRetryDue({ portal: { invitedAt: null } }, now), true);
  assert.strictEqual(w.inviteRetryDue({ portal: { invitedAt: now } }, now), false, 'already invited');
  assert.strictEqual(w.inviteRetryDue({ portal: { inviteFailures: 1, lastInviteFailureAt: ago(10) } }, now), false);
  assert.strictEqual(w.inviteRetryDue({ portal: { inviteFailures: 1, lastInviteFailureAt: ago(15) } }, now), true);
  assert.strictEqual(w.inviteRetryDue({ portal: { inviteFailures: 3, lastInviteFailureAt: ago(59) } }, now), false);
  assert.strictEqual(w.inviteRetryDue({ portal: { inviteFailures: 3, lastInviteFailureAt: ago(60) } }, now), true);
  assert.strictEqual(w.inviteBackoffMs(9), 6 * 60 * 60 * 1000);
  assert.strictEqual(w.inviteRetryDue({ portal: { inviteFailures: w.MAX_INVITE_FAILURES, lastInviteFailureAt: ago(9999) } }, now), false);
});

module.exports = done();

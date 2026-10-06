const express = require('express');
const nodemailer = require('nodemailer');
const MailAccount = require('../models/MailAccount');
const EmailThread = require('../models/EmailThread');
const EmailMessage = require('../models/EmailMessage');
const EmailAttachment = require('../models/EmailAttachment');
const env = require('../config/env');
const secrets = require('../services/secrets');
const { encrypt, decrypt } = require('../services/secretBox');
const imap = require('../services/mail/imap');
const graph = require('../services/mail/graph');
const msAuth = require('../services/mail/microsoftAuth');
const { syncAccount, isSyncing } = require('../services/mail/sync');
const { PRESETS, guessImapHost, isMicrosoftHost } = require('../services/mail/presets');
const { normalizeEmail } = require('../services/mail/text');

const router = express.Router();

const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#dc2626', '#475569'];

async function nextColor() {
  const used = new Set((await MailAccount.find().select('color').lean()).map((a) => a.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[0];
}

async function ensureOneDefault() {
  const accounts = await MailAccount.find().sort({ createdAt: 1 });
  if (accounts.length && !accounts.some((a) => a.isDefault)) {
    accounts[0].isDefault = true;
    await accounts[0].save();
  }
}

function serverCfg(input = {}, stored = {}) {
  return {
    host: String(input.host ?? stored.host ?? '').trim(),
    port: Number(input.port ?? stored.port) || 0,
    secure: input.secure != null ? Boolean(input.secure) : stored.secure !== false,
    user: String(input.user ?? stored.user ?? '').trim(),
    pass: input.pass ? String(input.pass) : decrypt(stored.passEnc),
  };
}

async function testSmtp(cfg) {
  try {
    const t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 465,
      secure: cfg.secure && Number(cfg.port) !== 587,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 15_000,
    });
    await t.verify();
    return { ok: true, message: 'SMTP login OK.' };
  } catch (err) {
    return { ok: false, message: `SMTP: ${err.response || err.message}` };
  }
}

router.get('/', async (req, res) => {
  const accounts = await MailAccount.find().sort({ isDefault: -1, createdAt: 1 });
  res.json({
    accounts: accounts.map((a) => ({ ...a.toPublic(), syncing: isSyncing(a._id) })),
    presets: PRESETS,
    envSmtp: {
      configured: env.smtp.configured,
      host: env.smtp.host,
      port: env.smtp.port,
      user: env.smtp.user,
      from: env.smtp.from,
      guessedImapHost: guessImapHost(env.smtp.host),
      microsoft: isMicrosoftHost(env.smtp.host),
    },
    microsoft: { configured: secrets.microsoftConfigured(), redirectUri: msAuth.redirectUri() },
    resend: { configured: secrets.resendConfigured() },
  });
});

// Test IMAP (and optionally SMTP) settings before saving. Blank passwords
// reuse the stored ones when editing (accountId) or the .env SMTP password
// when `useEnvSmtpLogin` is set.
router.post('/imap/test', async (req, res) => {
  const { accountId, imap: imapIn = {}, smtp: smtpIn, useEnvSmtpLogin } = req.body || {};
  const stored = accountId ? await MailAccount.findById(accountId) : null;
  const imapCfg = serverCfg(imapIn, stored?.imap || {});
  if (useEnvSmtpLogin && !imapIn.pass) {
    imapCfg.user = imapCfg.user || env.smtp.user;
    imapCfg.pass = env.smtp.pass;
  }
  if (!imapCfg.host) return res.status(400).json({ ok: false, message: 'IMAP host is required.' });
  if (isMicrosoftHost(imapCfg.host)) {
    return res.json({
      ok: false,
      message: 'Microsoft 365 / Exchange Online does not accept IMAP passwords. Use “Connect Microsoft 365” instead.',
      microsoft: true,
    });
  }
  const imapResult = await imap.test(imapCfg);
  let smtpResult = null;
  if (smtpIn && smtpIn.host) smtpResult = await testSmtp(serverCfg(smtpIn, stored?.outgoing?.smtp || {}));
  res.json({ ok: imapResult.ok && (!smtpResult || smtpResult.ok), imap: imapResult, smtp: smtpResult });
});

router.post('/imap', async (req, res) => {
  const b = req.body || {};
  const email = normalizeEmail(b.email);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email address is required.' });
  if (await MailAccount.findOne({ email })) return res.status(409).json({ error: `${email} is already connected.` });
  const imapCfg = serverCfg(b.imap || {});
  if (b.useEnvSmtpLogin) {
    imapCfg.user = imapCfg.user || env.smtp.user;
    if (!imapCfg.pass) imapCfg.pass = env.smtp.pass;
  }
  imapCfg.user = imapCfg.user || email;
  if (!imapCfg.host || !imapCfg.pass) return res.status(400).json({ error: 'IMAP host and password are required.' });
  if (isMicrosoftHost(imapCfg.host)) {
    return res.status(400).json({ error: 'Microsoft 365 mailboxes connect with “Connect Microsoft 365”, not IMAP.' });
  }
  const test = await imap.test(imapCfg);
  if (!test.ok) return res.status(400).json({ error: test.message });

  const via = ['smtp', 'env_smtp', 'resend'].includes(b.outgoing?.via) ? b.outgoing.via : 'smtp';
  const smtpCfg = serverCfg(b.outgoing?.smtp || {});
  if (via === 'smtp' && !smtpCfg.pass) smtpCfg.pass = imapCfg.pass;
  if (via === 'smtp' && !smtpCfg.user) smtpCfg.user = imapCfg.user;
  const account = await MailAccount.create({
    kind: 'imap',
    label: b.label || email,
    email,
    displayName: b.displayName || '',
    color: b.color || (await nextColor()),
    imap: { host: imapCfg.host, port: imapCfg.port || 993, secure: imapCfg.secure, user: imapCfg.user, passEnc: encrypt(imapCfg.pass) },
    outgoing: {
      via,
      smtp:
        via === 'smtp'
          ? { host: smtpCfg.host, port: smtpCfg.port || 465, secure: smtpCfg.secure, user: smtpCfg.user, passEnc: encrypt(smtpCfg.pass) }
          : {},
    },
  });
  await ensureOneDefault();
  syncAccount(account._id, { trigger: 'connect' }).catch(() => {});
  res.status(201).json({ ...account.toPublic(), syncing: true, test: test.message });
});

// Start "Sign in with Microsoft". Returns the URL the browser should open.
router.post('/microsoft/connect', async (req, res) => {
  if (!secrets.microsoftConfigured()) {
    return res.status(400).json({ error: 'Set up the Microsoft 365 app registration first (Integrations → Microsoft 365).' });
  }
  const { accountId = '', mailbox = '', label = '', color = '', returnTo = '/integrations', loginHint = '' } = req.body || {};
  const origin = String(req.get('origin') || '').replace(/\/+$/, '');
  const url = msAuth.buildAuthorizeUrl({
    accountId: String(accountId),
    mailbox: normalizeEmail(mailbox),
    label,
    color,
    returnTo: `${origin}${String(returnTo).startsWith('/') ? returnTo : '/integrations'}`,
    loginHint,
  });
  res.json({ url });
});

// App-only (client-credentials) mailbox: no sign-in, needs admin-consented
// application permissions on the app registration.
router.post('/microsoft/app', async (req, res) => {
  const { mailbox, label, color, displayName } = req.body || {};
  const email = normalizeEmail(mailbox);
  if (!email.includes('@')) return res.status(400).json({ error: 'Enter the mailbox address to read.' });
  if (!secrets.microsoftConfigured()) return res.status(400).json({ error: 'Set up the Microsoft 365 app registration first.' });
  if (await MailAccount.findOne({ email })) return res.status(409).json({ error: `${email} is already connected.` });
  const account = new MailAccount({
    kind: 'microsoft',
    label: label || email,
    email,
    displayName: displayName || '',
    color: color || (await nextColor()),
    outgoing: { via: 'graph' },
    microsoft: { authMode: 'app', mailbox: email },
  });
  try {
    await graph.testMailbox(account);
  } catch (err) {
    return res.status(400).json({ error: graph.describeError(err) });
  }
  await account.save();
  await ensureOneDefault();
  syncAccount(account._id, { trigger: 'connect' }).catch(() => {});
  res.status(201).json({ ...account.toPublic(), syncing: true });
});

router.patch('/:id', async (req, res) => {
  const account = await MailAccount.findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  for (const k of ['label', 'displayName', 'color', 'signatureHtml']) if (b[k] != null) account[k] = String(b[k]);
  if (b.enabled != null) account.enabled = Boolean(b.enabled);
  if (b.isDefault === true) {
    await MailAccount.updateMany({ _id: { $ne: account._id } }, { $set: { isDefault: false } });
    account.isDefault = true;
  }
  if (account.kind === 'imap' && b.imap) {
    const cfg = serverCfg(b.imap, account.imap);
    if (isMicrosoftHost(cfg.host)) return res.status(400).json({ error: 'Microsoft 365 needs the Microsoft 365 connector.' });
    if (b.imap.host != null || b.imap.pass || b.imap.user != null || b.imap.port != null) {
      const t = await imap.test(cfg);
      if (!t.ok) return res.status(400).json({ error: t.message });
    }
    account.imap = { host: cfg.host, port: cfg.port || 993, secure: cfg.secure, user: cfg.user, passEnc: encrypt(cfg.pass) };
  }
  if (b.outgoing) {
    const allowed = account.kind === 'microsoft' ? ['graph', 'smtp', 'env_smtp', 'resend'] : ['smtp', 'env_smtp', 'resend'];
    if (b.outgoing.via && allowed.includes(b.outgoing.via)) account.outgoing.via = b.outgoing.via;
    if (b.outgoing.smtp) {
      const cfg = serverCfg(b.outgoing.smtp, account.outgoing?.smtp || {});
      account.outgoing.smtp = { host: cfg.host, port: cfg.port || 465, secure: cfg.secure, user: cfg.user, passEnc: encrypt(cfg.pass) };
    }
  }
  if (b.microsoft?.mailbox != null && account.kind === 'microsoft') account.microsoft.mailbox = normalizeEmail(b.microsoft.mailbox);
  await account.save();
  await ensureOneDefault();
  res.json(account.toPublic());
});

router.post('/:id/test', async (req, res) => {
  const account = await MailAccount.findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  if (account.kind === 'microsoft') {
    try {
      return res.json(await graph.testMailbox(account));
    } catch (err) {
      return res.json({ ok: false, message: err.needsAuth ? err.message : graph.describeError(err) });
    }
  }
  const r = await imap.test(imap.imapConfig(account));
  res.json(r);
});

router.post('/:id/sync', async (req, res) => {
  const account = await MailAccount.findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  const r = await syncAccount(account._id, { trigger: 'manual' });
  res.json(r);
});

// Remove a mailbox and everything synced from it.
router.delete('/:id', async (req, res) => {
  const account = await MailAccount.findById(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  const msgIds = await EmailMessage.find({ account: account._id }).distinct('_id');
  await EmailAttachment.deleteMany({ message: { $in: msgIds } });
  await EmailMessage.deleteMany({ account: account._id });
  await EmailThread.deleteMany({ account: account._id });
  await account.deleteOne();
  await ensureOneDefault();
  res.json({ ok: true });
});

module.exports = router;

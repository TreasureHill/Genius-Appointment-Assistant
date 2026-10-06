const MailAccount = require('../../models/MailAccount');
const EmailMessage = require('../../models/EmailMessage');
const Setting = require('../../models/Setting');
const graph = require('./graph');
const imap = require('./imap');

// Runs the provider sync for each mailbox with one in-flight sync per
// mailbox, records state for the UI, and backs off from failing mailboxes.

const running = new Map(); // accountId -> Promise
const ERROR_BACKOFF_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 45_000;

function providerFor(account) {
  return account.kind === 'microsoft' ? graph : imap;
}

function describe(account, err) {
  if (err?.needsAuth) return err.message;
  return account.kind === 'microsoft' ? graph.describeError(err) : imap.describeError(err);
}

async function syncAccount(accountId, { trigger = 'auto' } = {}) {
  const id = String(accountId);
  if (running.has(id)) return running.get(id);
  const job = (async () => {
    const account = await MailAccount.findById(id);
    if (!account || !account.enabled) return { ok: false, skipped: true, message: 'Mailbox disabled.' };
    const s = await Setting.getSingleton();
    const opts = {
      initialSyncDays: s.inbox?.initialSyncDays || 30,
      initialSyncMax: s.inbox?.initialSyncMax || 400,
    };
    await MailAccount.updateOne({ _id: id }, { $set: { 'sync.state': 'syncing' } });
    const started = Date.now();
    try {
      const r = await providerFor(account).sync(account, opts);
      const count = await EmailMessage.countDocuments({ account: id });
      await MailAccount.updateOne(
        { _id: id },
        {
          $set: {
            'sync.state': 'ok',
            'sync.message': r.added ? `${r.added} new message${r.added === 1 ? '' : 's'}` : 'Up to date',
            'sync.lastSyncAt': new Date(),
            'sync.lastOkAt': new Date(),
            'sync.initialDone': true,
            'sync.messageCount': count,
          },
        }
      );
      if (r.added || trigger !== 'auto') {
        console.log(`[mail] ${account.email}: synced in ${Date.now() - started} ms, ${r.added} new (${trigger})`);
      }
      return { ok: true, added: r.added };
    } catch (err) {
      const needsAuth = Boolean(err?.needsAuth) || err?.response?.status === 401;
      const message = describe(account, err);
      console.warn(`[mail] ${account.email}: sync failed — ${message}`);
      await MailAccount.updateOne(
        { _id: id },
        { $set: { 'sync.state': needsAuth ? 'needs_auth' : 'error', 'sync.message': message, 'sync.lastSyncAt': new Date() } }
      );
      return { ok: false, message, needsAuth };
    }
  })().finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

async function syncAll({ trigger = 'auto', force = false } = {}) {
  const accounts = await MailAccount.find({ enabled: true }).select('_id sync kind').lean();
  const now = Date.now();
  const due = accounts.filter((a) => {
    if (force) return true;
    const last = a.sync?.lastSyncAt ? new Date(a.sync.lastSyncAt).getTime() : 0;
    if (a.sync?.state === 'needs_auth') return false; // waits for a reconnect
    if (a.sync?.state === 'error') return now - last > ERROR_BACKOFF_MS;
    return now - last > MIN_INTERVAL_MS;
  });
  const results = await Promise.all(due.map((a) => syncAccount(a._id, { trigger })));
  return { ok: true, synced: due.length, results };
}

function isSyncing(accountId) {
  return running.has(String(accountId));
}

module.exports = { syncAccount, syncAll, isSyncing, providerFor };

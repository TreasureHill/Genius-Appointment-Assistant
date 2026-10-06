const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const EmailMessage = require('../../models/EmailMessage');
const { decrypt } = require('../secretBox');
const { upsertMessage, markGone, selfEmailsOf, refreshThread } = require('./store');
const { htmlToText, normalizeEmail, snippetFrom } = require('./text');

// Any IMAP mailbox: reads INBOX + the Sent folder incrementally by UID,
// reconciles read/flag state and messages moved away, and writes flags /
// moves back. Exchange Online is not served here (it refuses IMAP passwords —
// use the Microsoft 365 connector).

const BATCH = 25;
const RECONCILE_WINDOW = 400; // most recent stored messages per folder whose flags we re-check

function connectionOptions(cfg) {
  return {
    host: cfg.host,
    port: Number(cfg.port) || (cfg.secure === false ? 143 : 993),
    secure: cfg.secure !== false,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  };
}

function imapConfig(account) {
  return {
    host: account.imap?.host,
    port: account.imap?.port,
    secure: account.imap?.secure,
    user: account.imap?.user || account.email,
    pass: decrypt(account.imap?.passEnc),
  };
}

async function withClient(cfg, fn) {
  const client = new ImapFlow(connectionOptions(cfg));
  // Socket errors after connect surface here; without a listener they'd crash
  // the process.
  client.on('error', (err) => console.warn(`[imap] ${cfg.host}: ${err.message}`));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function describeError(err) {
  const text = String(err?.responseText || err?.message || err || '');
  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(text)) {
    return 'The mail server rejected the username or password. Gmail / Yahoo / iCloud need an app password; Microsoft 365 needs the Microsoft 365 connector.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(text)) return 'Mail server not found — check the IMAP host name.';
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(text)) return 'Could not reach the mail server — check host, port and SSL.';
  if (/certificate/i.test(text)) return 'The mail server presented an invalid TLS certificate.';
  return text || 'IMAP error';
}

async function test(cfg) {
  try {
    return await withClient(cfg, async (client) => {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      return { ok: true, message: `Inbox reachable — ${status.messages ?? '?'} messages, ${status.unseen ?? '?'} unread.` };
    });
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

async function resolveFolders(client) {
  const list = await client.list();
  const bySpecial = (flag) => list.find((f) => f.specialUse === flag)?.path || '';
  return {
    inbox: 'INBOX',
    sent: bySpecial('\\Sent'),
    archive: bySpecial('\\Archive') || bySpecial('\\All'),
    trash: bySpecial('\\Trash'),
  };
}

const toAddr = (a) => ({ name: a?.name || '', email: normalizeEmail(a?.address) });
const listOf = (field) => (field?.value || []).map(toAddr).filter((a) => a.email);

async function parse(account, raw, { role, path, uid, uidValidity, flags, internalDate }) {
  // skipHtmlToText: for HTML-only mail we derive the text ourselves (mailparser
  // would uppercase headings and inline image URLs into snippets).
  const parsed = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true, skipHtmlToText: true });
  const from = listOf(parsed.from)[0] || { name: '', email: '' };
  const self = selfEmailsOf(account);
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const text = parsed.text || htmlToText(html);
  const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const direction = role === 'sent' || self.has(from.email) ? 'out' : 'in';
  const msg = {
    messageId: parsed.messageId || `<imap-${uidValidity}-${uid}@${path.replace(/[^a-z0-9]/gi, '')}.local>`,
    inReplyTo: parsed.inReplyTo || '',
    references: refs.slice(-30),
    imapPath: path,
    uid,
    uidValidity,
    folder: role,
    direction,
    from,
    to: listOf(parsed.to),
    cc: listOf(parsed.cc),
    bcc: listOf(parsed.bcc),
    replyTo: listOf(parsed.replyTo),
    subject: parsed.subject || '',
    date: parsed.date || internalDate || new Date(),
    html: html.length > 1_500_000 ? '' : html,
    text: text.slice(0, 300_000),
    snippet: snippetFrom(text),
    isRead: direction === 'out' ? true : flags.has('\\Seen'),
    isFlagged: flags.has('\\Flagged'),
    hasAttachments: (parsed.attachments || []).some((a) => !(a.related || a.contentDisposition === 'inline')),
    attachmentsLoaded: true,
  };
  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || (a.contentType ? `attachment.${a.contentType.split('/')[1] || 'bin'}` : 'attachment'),
    contentType: a.contentType,
    size: a.size,
    contentId: a.cid || a.contentId || '',
    inline: Boolean(a.related || a.contentDisposition === 'inline'),
    data: a.content,
  }));
  return { msg, attachments };
}

async function syncFolder(client, account, role, path, { initialSyncDays, initialSyncMax }) {
  const lock = await client.getMailboxLock(path);
  let added = 0;
  try {
    const uidValidity = String(client.mailbox.uidValidity);
    const folders = { ...(account.sync.folders || {}) };
    let st = folders[role];
    if (!st || st.uidValidity !== uidValidity || st.path !== path) st = { path, uidValidity, lastUid: 0 };

    let uids;
    if (!st.lastUid) {
      uids = (await client.search({ since: new Date(Date.now() - initialSyncDays * 864e5) }, { uid: true })) || [];
      uids = uids.slice(-initialSyncMax);
    } else {
      uids = ((await client.search({ uid: `${st.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > st.lastUid);
    }
    uids.sort((a, b) => a - b);

    for (let i = 0; i < uids.length; i += BATCH) {
      const batch = uids.slice(i, i + BATCH);
      const fetched = [];
      // Collect first, then parse/store: the IMAP stream must be drained
      // before issuing other commands on this connection.
      for await (const m of client.fetch(batch.join(','), { uid: true, flags: true, source: true, internalDate: true }, { uid: true })) {
        fetched.push(m);
      }
      for (const m of fetched) {
        try {
          const { msg, attachments } = await parse(account, m.source, {
            role,
            path,
            uid: m.uid,
            uidValidity,
            flags: m.flags || new Set(),
            internalDate: m.internalDate,
          });
          const res = await upsertMessage(account, msg, { attachments });
          if (res.created) added += 1;
        } catch (err) {
          console.warn(`[imap] ${account.email}: could not store uid ${m.uid} in ${path}: ${err.message}`);
        }
        st.lastUid = Math.max(st.lastUid, m.uid);
      }
    }
    if (!uids.length && !st.lastUid && client.mailbox.uidNext) st.lastUid = Number(client.mailbox.uidNext) - 1;

    await reconcile(client, account, role, path, uidValidity);

    folders[role] = st;
    account.sync.folders = folders;
    account.markModified('sync.folders');
    await account.save();
  } finally {
    lock.release();
  }
  return added;
}

// Re-check the most recent stored messages of this folder: which are still
// there (moved/deleted elsewhere -> folder 'other') and their \Seen/\Flagged.
async function reconcile(client, account, role, path, uidValidity) {
  const stored = await EmailMessage.find({ account: account._id, imapPath: path, uidValidity, folder: role })
    .sort({ uid: -1 })
    .limit(RECONCILE_WINDOW)
    .select('uid isRead isFlagged thread direction');
  if (!stored.length) return;
  const minUid = stored[stored.length - 1].uid;
  const present = new Map();
  for await (const m of client.fetch(`${minUid}:*`, { uid: true, flags: true }, { uid: true })) {
    present.set(m.uid, m.flags || new Set());
  }
  const touched = new Set();
  const gone = [];
  for (const row of stored) {
    const flags = present.get(row.uid);
    if (!flags) {
      gone.push(row._id);
      continue;
    }
    const isRead = row.direction === 'out' ? true : flags.has('\\Seen');
    const isFlagged = flags.has('\\Flagged');
    if (isRead !== row.isRead || isFlagged !== row.isFlagged) {
      row.isRead = isRead;
      row.isFlagged = isFlagged;
      await row.save();
      touched.add(String(row.thread));
    }
  }
  if (gone.length) await markGone(account, { _id: { $in: gone } });
  for (const t of touched) await refreshThread(t, account);
}

async function sync(account, opts) {
  return withClient(imapConfig(account), async (client) => {
    const folders = await resolveFolders(client);
    let added = await syncFolder(client, account, 'inbox', folders.inbox, opts);
    if (folders.sent) added += await syncFolder(client, account, 'sent', folders.sent, opts);
    return { added, folders };
  });
}

async function setFlags(account, message, { isRead, isFlagged }) {
  if (!message.imapPath || !message.uid) return;
  await withClient(imapConfig(account), async (client) => {
    const lock = await client.getMailboxLock(message.imapPath);
    try {
      const range = String(message.uid);
      if (isRead === true) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
      if (isRead === false) await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      if (isFlagged === true) await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
      if (isFlagged === false) await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
    } finally {
      lock.release();
    }
  });
}

// target: 'archive' | 'trash' | 'inbox'. Returns false when the server has no
// such folder (archiving then stays local to the app).
// Where the message is now: its stored location if it's still there,
// otherwise looked up by Message-ID in Archive / All Mail / INBOX (it may
// have been moved in another mail client).
async function locate(client, message, folders) {
  const candidates = [message.imapPath, folders.archive, folders.inbox, folders.trash].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    const lock = await client.getMailboxLock(path);
    try {
      if (path === message.imapPath && message.uid) {
        const hit = await client.search({ uid: String(message.uid) }, { uid: true });
        if (hit && hit.includes(message.uid)) return { path, uid: message.uid };
      }
      const found = await client.search({ header: { 'message-id': message.messageId } }, { uid: true });
      if (found && found.length) return { path, uid: found[found.length - 1] };
    } catch {
      /* folder unreadable — try the next */
    } finally {
      lock.release();
    }
  }
  return null;
}

async function move(account, message, target) {
  if (!message.imapPath && !message.messageId) return false;
  return withClient(imapConfig(account), async (client) => {
    const folders = await resolveFolders(client);
    const dest = folders[target];
    if (!dest) return false;
    const at = await locate(client, message, folders);
    if (!at || at.path === dest) return false;
    const lock = await client.getMailboxLock(at.path);
    try {
      const res = await client.messageMove(String(at.uid), dest, { uid: true });
      const newUid = res?.uidMap?.get?.(at.uid);
      message.imapPath = dest;
      message.uid = newUid || null;
      message.uidValidity = res?.uidValidity ? String(res.uidValidity) : '';
      message.folder = target;
      await message.save();
      return true;
    } finally {
      lock.release();
    }
  });
}

// Put a copy of a message we sent into the Sent folder (SMTP servers other
// than Gmail don't do that themselves).
async function appendToSent(account, raw) {
  return withClient(imapConfig(account), async (client) => {
    const folders = await resolveFolders(client);
    if (!folders.sent) return false;
    await client.append(folders.sent, raw, ['\\Seen']);
    return true;
  });
}

module.exports = { sync, test, setFlags, move, appendToSent, describeError, imapConfig, resolveFolders, withClient };

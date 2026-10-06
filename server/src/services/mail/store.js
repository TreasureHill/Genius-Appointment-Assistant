const EmailMessage = require('../../models/EmailMessage');
const EmailThread = require('../../models/EmailThread');
const EmailAttachment = require('../../models/EmailAttachment');
const Lot = require('../../models/Lot');
const MessageLog = require('../../models/MessageLog');
require('../../models/Project');
const { normalizeEmail, normalizeSubject, snippetFrom } = require('./text');

// Where synced and sent messages land. A message is identified in its mailbox
// by its Internet Message-ID; a thread by Outlook's conversationId (Microsoft
// 365) or, for IMAP, by the References / In-Reply-To chain with a subject +
// counterpart fallback for clients that drop those headers.

const ATTACHMENT_CACHE_MAX = 8 * 1024 * 1024;
const SUBJECT_FALLBACK_DAYS = 45;

function selfEmailsOf(account) {
  return new Set(
    [account.email, account.microsoft?.userPrincipalName, account.microsoft?.mailbox, account.imap?.user]
      .map(normalizeEmail)
      .filter((e) => e && e.includes('@'))
  );
}

// Pure: is there a counterpart (someone other than the mailbox) in common?
function sharesCounterpart(a, b, self) {
  const left = new Set(a.map((p) => normalizeEmail(p.email)).filter((e) => e && !self.has(e)));
  return b.some((p) => {
    const e = normalizeEmail(p.email);
    return e && !self.has(e) && left.has(e);
  });
}

function peopleOf(msg) {
  return [msg.from, ...(msg.to || []), ...(msg.cc || []), ...(msg.replyTo || [])].filter((p) => p && p.email);
}

async function findThreadFor(account, msg, self) {
  if (msg.conversationId) {
    return EmailThread.findOne({ account: account._id, key: `conv:${msg.conversationId}` });
  }
  const refs = [msg.inReplyTo, ...(msg.references || [])].filter(Boolean);
  if (refs.length) {
    const parent = await EmailMessage.findOne({ account: account._id, messageId: { $in: refs } }).select('thread').lean();
    if (parent?.thread) {
      const t = await EmailThread.findById(parent.thread);
      if (t) return t;
    }
  }
  const norm = normalizeSubject(msg.subject);
  if (norm && norm.length >= 3) {
    const since = new Date((msg.date ? new Date(msg.date).getTime() : Date.now()) - SUBJECT_FALLBACK_DAYS * 864e5);
    const candidates = await EmailThread.find({
      account: account._id,
      normalizedSubject: norm,
      lastMessageAt: { $gte: since },
    })
      .sort({ lastMessageAt: -1 })
      .limit(5);
    const people = peopleOf(msg);
    const hit = candidates.find((t) => sharesCounterpart(t.participants || [], people, self));
    if (hit) return hit;
  }
  return null;
}

async function createThread(account, msg) {
  const key = msg.conversationId ? `conv:${msg.conversationId}` : `msg:${msg.messageId}`;
  try {
    return await EmailThread.create({
      account: account._id,
      key,
      subject: msg.subject || '(no subject)',
      normalizedSubject: normalizeSubject(msg.subject),
      lastMessageAt: msg.date || new Date(),
    });
  } catch (err) {
    if (err?.code === 11000) return EmailThread.findOne({ account: account._id, key });
    throw err;
  }
}

// Insert or update one message. `msg` is the normalized shape produced by the
// IMAP / Graph readers or the sender. Returns { message, thread, created }.
async function upsertMessage(account, msg, { attachments = [], origin = 'sync' } = {}) {
  const self = selfEmailsOf(account);
  let existing = await EmailMessage.findOne({ account: account._id, messageId: msg.messageId });

  // A message we sent through Graph is stored before Microsoft hands back its
  // final Message-ID; adopt that pending row instead of duplicating it.
  if (!existing && origin === 'sync' && msg.direction === 'out' && msg.conversationId) {
    existing = await EmailMessage.findOne({
      account: account._id,
      origin: 'app',
      messageId: /^pending:/,
      conversationId: msg.conversationId,
      date: { $gte: new Date(Date.now() - 6 * 3600e3) },
    }).sort({ date: -1 });
    if (existing) existing.messageId = msg.messageId;
  }

  if (existing) {
    const before = { folder: existing.folder, isRead: existing.isRead, isFlagged: existing.isFlagged };
    // A message in both Inbox and Sent (mail to yourself) stays an Inbox one.
    if (!(existing.folder === 'inbox' && msg.folder === 'sent')) existing.folder = msg.folder || existing.folder;
    for (const k of ['remoteId', 'imapPath', 'uidValidity', 'conversationId']) if (msg[k]) existing[k] = msg[k];
    if (msg.uid != null && msg.folder === existing.folder) existing.uid = msg.uid;
    if (typeof msg.isRead === 'boolean') existing.isRead = msg.isRead;
    if (typeof msg.isFlagged === 'boolean') existing.isFlagged = msg.isFlagged;
    if (!existing.html && msg.html) existing.html = msg.html;
    if (!existing.text && msg.text) existing.text = msg.text;
    await existing.save();
    const changed = before.folder !== existing.folder || before.isRead !== existing.isRead || before.isFlagged !== existing.isFlagged;
    const thread = changed ? await refreshThread(existing.thread, account) : await EmailThread.findById(existing.thread);
    return { message: existing, thread, created: false };
  }

  let thread = await findThreadFor(account, msg, self);
  if (!thread) thread = await createThread(account, msg);

  let message;
  try {
    message = await EmailMessage.create({
      ...msg,
      account: account._id,
      thread: thread._id,
      snippet: msg.snippet || snippetFrom(msg.text),
      origin,
      attachmentsLoaded: msg.attachmentsLoaded ?? origin === 'app',
    });
  } catch (err) {
    // Two syncs racing on the same message: the other one won.
    if (err?.code === 11000) {
      const m = await EmailMessage.findOne({ account: account._id, messageId: msg.messageId });
      return { message: m, thread: await EmailThread.findById(m.thread), created: false };
    }
    throw err;
  }

  if (attachments.length) await saveAttachments(account, message, attachments);

  // New mail on an archived conversation brings it back, like Gmail/Outlook.
  if (msg.direction === 'in' && thread.archived) {
    thread.archived = false;
    await thread.save();
  }
  thread = await refreshThread(thread._id, account);
  if (thread?.lot) await logToLot(thread, message).catch(() => {});
  return { message, thread, created: true };
}

// Mirror inbox mail with a lot's buyers into the lot's message history, so the
// lot page and Activity (incl. "replies received") show email conversations.
async function logToLot(thread, message) {
  const lot = await Lot.findById(thread.lot).select('project').lean();
  if (!lot) return;
  await MessageLog.create({
    project: lot.project,
    lot: lot._id,
    type: 'email',
    direction: message.direction,
    to: message.direction === 'out' ? (message.to || []).map((a) => a.email).join(', ') : message.from?.email || '',
    subject: message.subject || '',
    body: message.html || message.text || '',
    status: message.direction === 'out' ? 'sent' : 'received',
    providerId: message.messageId,
    sentAt: message.date || new Date(),
  });
}

async function saveAttachments(account, message, attachments) {
  const rows = attachments.map((a) => {
    const size = a.size || (a.data ? a.data.length : 0);
    const keep = a.data && size <= ATTACHMENT_CACHE_MAX;
    return {
      account: account._id,
      message: message._id,
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size,
      contentId: String(a.contentId || '').replace(/^<|>$/g, ''),
      inline: Boolean(a.inline),
      remoteId: a.remoteId || '',
      data: keep ? a.data : null,
      tooLarge: Boolean(a.data && !keep),
    };
  });
  if (rows.length) await EmailAttachment.insertMany(rows);
  if (!message.hasAttachments && rows.some((r) => !r.inline)) {
    message.hasAttachments = true;
    await message.save();
  }
}

// Recompute a thread's rollups from its messages. Cheap: threads are small and
// this only runs when one of their messages changed.
async function refreshThread(threadId, account) {
  const thread = await EmailThread.findById(threadId);
  if (!thread) return null;
  const msgs = await EmailMessage.find({ thread: thread._id })
    .select('from to cc replyTo subject date direction isRead folder hasAttachments snippet')
    .sort({ date: 1 })
    .lean();
  if (!msgs.length) {
    await EmailThread.deleteOne({ _id: thread._id });
    return null;
  }
  const self = selfEmailsOf(account);
  const people = new Map();
  for (const m of msgs) {
    for (const p of peopleOf(m)) {
      const e = normalizeEmail(p.email);
      if (!e || self.has(e)) continue;
      const prev = people.get(e);
      if (!prev || (!prev.name && p.name)) people.set(e, { email: e, name: p.name || prev?.name || '' });
    }
  }
  const last = msgs[msgs.length - 1];
  const firstWithSubject = msgs.find((m) => m.subject) || last;
  thread.subject = firstWithSubject.subject || '(no subject)';
  thread.normalizedSubject = normalizeSubject(thread.subject);
  thread.participants = [...people.values()].slice(0, 30);
  thread.lastFrom = { name: last.from?.name || '', email: normalizeEmail(last.from?.email) };
  thread.lastDirection = last.direction;
  thread.lastMessageAt = last.date || thread.lastMessageAt;
  thread.messageCount = msgs.length;
  thread.unreadCount = msgs.filter((m) => m.direction === 'in' && !m.isRead).length;
  thread.snippet = last.snippet || '';
  thread.hasAttachments = msgs.some((m) => m.hasAttachments);
  thread.hasInbound = msgs.some((m) => m.direction === 'in');
  thread.hasOutbound = msgs.some((m) => m.direction === 'out');
  thread.inInbox = msgs.some((m) => m.folder === 'inbox');
  if (!thread.lot && thread.participants.length) {
    thread.lot = await findLotFor(thread.participants.map((p) => p.email));
  }
  await thread.save();
  return thread;
}

async function findLotFor(emails) {
  const list = emails.map(normalizeEmail).filter(Boolean);
  if (!list.length) return null;
  const lot = await Lot.findOne({ 'buyers.email': { $in: list } }).sort({ updatedAt: -1 }).select('_id').lean();
  return lot?._id || null;
}

// The provider says a message left a folder we sync (moved / deleted
// elsewhere). Keep it, but it no longer counts as "in the Inbox".
async function markGone(account, filter) {
  const rows = await EmailMessage.find({ account: account._id, ...filter }).select('_id thread folder');
  const threads = new Set();
  for (const r of rows) {
    r.folder = 'other';
    await r.save();
    threads.add(String(r.thread));
  }
  for (const t of threads) await refreshThread(t, account);
  return rows.length;
}

module.exports = {
  upsertMessage,
  refreshThread,
  saveAttachments,
  markGone,
  findLotFor,
  selfEmailsOf,
  sharesCounterpart,
  ATTACHMENT_CACHE_MAX,
};

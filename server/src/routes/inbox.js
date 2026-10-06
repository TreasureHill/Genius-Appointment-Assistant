const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const EmailThread = require('../models/EmailThread');
const EmailMessage = require('../models/EmailMessage');
const EmailAttachment = require('../models/EmailAttachment');
const MailAccount = require('../models/MailAccount');
const Lot = require('../models/Lot');
require('../models/Project');
const secrets = require('../services/secrets');
const graph = require('../services/mail/graph');
const { updateThread } = require('../services/mail/actions');
const { sendEmail } = require('../services/mail/send');
const { syncAll, syncAccount, isSyncing } = require('../services/mail/sync');
const { parseAddressList, normalizeEmail } = require('../services/mail/text');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

// Views of the unified inbox. Every view spans all connected mailboxes unless
// ?account= narrows it.
const VIEWS = {
  inbox: { trashed: false, archived: false, inInbox: true },
  unread: { trashed: false, archived: false, inInbox: true, unreadCount: { $gt: 0 } },
  starred: { trashed: false, starred: true },
  sent: { trashed: false, hasOutbound: true },
  all: { trashed: false },
  archived: { trashed: false, $or: [{ archived: true }, { inInbox: false, hasInbound: true }] },
  lots: { trashed: false, lot: { $ne: null } },
  knowledge: { knowledgeEntry: { $ne: null } },
  trash: { trashed: true },
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v) => mongoose.isValidObjectId(v);

async function accountMap() {
  const accounts = await MailAccount.find().select('email label color kind displayName enabled isDefault').lean();
  return new Map(accounts.map((a) => [String(a._id), a]));
}

function publicAccount(a) {
  return a ? { _id: a._id, email: a.email, label: a.label, color: a.color, kind: a.kind } : null;
}

function lotSummary(lot) {
  if (!lot) return null;
  return {
    _id: lot._id,
    lotNumber: lot.lotNumber,
    address: lot.address || '',
    status: lot.status,
    project: lot.project ? { _id: lot.project._id, name: lot.project.marketingName || lot.project.name } : null,
    appointment: lot.calendlyEvent?.startTime ? { startTime: lot.calendlyEvent.startTime, name: lot.calendlyEvent.name } : null,
    buyers: (lot.buyers || []).map((b) => ({ name: b.name, email: b.email, phone: b.phone, role: b.role })),
  };
}

router.get('/threads', async (req, res) => {
  const view = VIEWS[req.query.view] ? req.query.view : 'inbox';
  const filter = { ...VIEWS[view] };
  if (req.query.account && isId(req.query.account)) filter.account = req.query.account;
  const q = String(req.query.q || '').trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    let textHits = [];
    try {
      textHits = await EmailMessage.find({ $text: { $search: q } }).select('thread').limit(300).lean();
    } catch {
      /* text index still building */
    }
    const or = [
      { subject: re },
      { snippet: re },
      { 'participants.email': re },
      { 'participants.name': re },
      { _id: { $in: textHits.map((h) => h.thread) } },
    ];
    // A view can already carry its own $or (archived): combine with $and.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: or }];
      delete filter.$or;
    } else filter.$or = or;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [rows, total, accounts] = await Promise.all([
    EmailThread.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'lot', select: 'lotNumber address status project calendlyEvent.startTime', populate: { path: 'project', select: 'name marketingName' } })
      .lean(),
    EmailThread.countDocuments(filter),
    accountMap(),
  ]);
  res.json({
    view,
    page,
    total,
    hasMore: page * limit < total,
    threads: rows.map((t) => ({
      _id: t._id,
      account: publicAccount(accounts.get(String(t.account))),
      subject: t.subject,
      participants: t.participants,
      lastFrom: t.lastFrom,
      lastDirection: t.lastDirection,
      lastMessageAt: t.lastMessageAt,
      messageCount: t.messageCount,
      unreadCount: t.unreadCount,
      snippet: t.snippet,
      hasAttachments: t.hasAttachments,
      starred: t.starred,
      archived: t.archived,
      trashed: t.trashed,
      inInbox: t.inInbox,
      inKnowledgeBase: Boolean(t.knowledgeEntry),
      lot: lotSummary(t.lot),
    })),
  });
});

// Inline images (cid:) become data: URIs so the sandboxed message frame can
// show them without cookies or network access to the app.
function inlineImages(html, attachments) {
  if (!html || !/cid:/i.test(html)) return html;
  const byCid = new Map(attachments.filter((a) => a.contentId && a.data).map((a) => [a.contentId.toLowerCase(), a]));
  return html.replace(/(["'(=]\s*)cid:([^"')\s>]+)/gi, (m, pre, cid) => {
    const att = byCid.get(String(cid).toLowerCase());
    if (!att || att.size > 2 * 1024 * 1024) return m;
    const data = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data.buffer || att.data);
    return `${pre}data:${att.contentType};base64,${data.toString('base64')}`;
  });
}

router.get('/threads/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const thread = await EmailThread.findById(req.params.id)
    .populate({ path: 'lot', populate: { path: 'project', select: 'name marketingName' } })
    .lean();
  if (!thread) return res.status(404).json({ error: 'not_found' });
  const account = await MailAccount.findById(thread.account);
  let messages = await EmailMessage.find({ thread: thread._id }).sort({ date: 1 });

  // Microsoft 365: list attachments the first time a message is opened.
  if (account?.kind === 'microsoft') {
    for (const m of messages.filter((x) => !x.attachmentsLoaded && x.remoteId).slice(0, 10)) {
      try {
        await graph.loadAttachments(account, m);
      } catch (err) {
        console.warn(`[mail] attachments for ${m._id}: ${graph.describeError(err)}`);
      }
    }
  }
  const atts = await EmailAttachment.find({ message: { $in: messages.map((m) => m._id) } }).lean();
  const attsByMsg = new Map();
  for (const a of atts) {
    const k = String(a.message);
    if (!attsByMsg.has(k)) attsByMsg.set(k, []);
    attsByMsg.get(k).push(a);
  }

  if (req.query.markRead === '1' && thread.unreadCount > 0) {
    await updateThread(thread._id, { read: true });
    messages = await EmailMessage.find({ thread: thread._id }).sort({ date: 1 });
  }

  res.json({
    thread: {
      _id: thread._id,
      subject: thread.subject,
      participants: thread.participants,
      starred: thread.starred,
      archived: thread.archived,
      trashed: thread.trashed,
      inInbox: thread.inInbox,
      unreadCount: req.query.markRead === '1' ? 0 : thread.unreadCount,
      knowledgeEntry: thread.knowledgeEntry,
      notes: thread.notes || [],
      lot: lotSummary(thread.lot),
    },
    account: account ? { ...publicAccount(account), displayName: account.displayName, signatureHtml: account.signatureHtml } : null,
    messages: messages.map((m) => {
      const list = attsByMsg.get(String(m._id)) || [];
      return {
        _id: m._id,
        messageId: m.messageId,
        direction: m.direction,
        from: m.from,
        to: m.to,
        cc: m.cc,
        bcc: m.bcc,
        replyTo: m.replyTo,
        subject: m.subject,
        date: m.date,
        html: inlineImages(m.html, list),
        text: m.html ? '' : m.text,
        snippet: m.snippet,
        isRead: m.isRead,
        isFlagged: m.isFlagged,
        origin: m.origin,
        sendVia: m.sendVia,
        attachments: list
          .filter((a) => !a.inline)
          .map((a) => ({ _id: a._id, filename: a.filename, contentType: a.contentType, size: a.size, tooLarge: a.tooLarge })),
      };
    }),
  });
});

router.patch('/threads/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const { read, starred, archived, trashed } = req.body || {};
  const t = await updateThread(req.params.id, { read, starred, archived, trashed });
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, thread: { _id: t._id, starred: t.starred, archived: t.archived, trashed: t.trashed, unreadCount: t.unreadCount, inInbox: t.inInbox } });
});

router.post('/threads/bulk', async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids_required' });
  const change = {
    read: { read: true },
    unread: { read: false },
    star: { starred: true },
    unstar: { starred: false },
    archive: { archived: true },
    unarchive: { archived: false },
    trash: { trashed: true },
    restore: { trashed: false },
  }[action];
  if (!change) return res.status(400).json({ error: 'invalid_action' });
  let done = 0;
  for (const id of ids.filter(isId).slice(0, 200)) {
    if (await updateThread(id, change)) done += 1;
  }
  res.json({ ok: true, updated: done });
});

function addresses(v) {
  return parseAddressList(v).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email));
}

// multipart: `payload` (JSON) + `files`. JSON bodies work too when there are
// no attachments.
router.post('/send', upload.array('files', 10), async (req, res) => {
  let p = req.body || {};
  if (typeof p.payload === 'string') {
    try {
      p = JSON.parse(p.payload);
    } catch {
      return res.status(400).json({ error: 'invalid_payload' });
    }
  }
  if (!p.accountId || !isId(p.accountId)) return res.status(400).json({ error: 'Choose which mailbox to send from.' });
  try {
    const { message, thread } = await sendEmail({
      accountId: p.accountId,
      mode: p.mode,
      replyToMessageId: p.replyToMessageId && isId(p.replyToMessageId) ? p.replyToMessageId : null,
      to: addresses(p.to),
      cc: addresses(p.cc),
      bcc: addresses(p.bcc),
      subject: String(p.subject || ''),
      html: String(p.html || ''),
      includeSignature: p.includeSignature !== false,
      files: (req.files || []).map((f) => ({ filename: f.originalname, contentType: f.mimetype, data: f.buffer, size: f.size })),
    });
    res.json({ ok: true, threadId: thread?._id, messageId: message?._id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/attachments/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const att = await EmailAttachment.findById(req.params.id);
  if (!att) return res.status(404).json({ error: 'not_found' });
  let data = att.data;
  if (!data && att.remoteId) {
    const [account, message] = await Promise.all([MailAccount.findById(att.account), EmailMessage.findById(att.message)]);
    try {
      data = await graph.downloadAttachment(account, message, att);
      if (data.length <= 8 * 1024 * 1024) {
        att.data = data;
        await att.save();
      }
    } catch (err) {
      return res.status(502).json({ error: graph.describeError(err) });
    }
  }
  if (!data) return res.status(410).json({ error: 'This attachment was too large to keep. Open it in your mail client.' });
  const inline = req.query.inline === '1' && /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(att.contentType);
  res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment')}`
  );
  res.send(Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data));
});

// People seen in mail + lot buyers, for the To/Cc autocomplete.
router.get('/contacts', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const re = new RegExp(escapeRegex(q), 'i');
  const [fromThreads, lots] = await Promise.all([
    EmailThread.aggregate([
      { $match: { $or: [{ 'participants.email': re }, { 'participants.name': re }] } },
      { $sort: { lastMessageAt: -1 } },
      { $limit: 200 },
      { $unwind: '$participants' },
      { $match: { $or: [{ 'participants.email': re }, { 'participants.name': re }] } },
      { $group: { _id: '$participants.email', name: { $max: '$participants.name' }, last: { $max: '$lastMessageAt' }, n: { $sum: 1 } } },
      { $sort: { n: -1, last: -1 } },
      { $limit: 10 },
    ]),
    Lot.find({ $or: [{ 'buyers.email': re }, { 'buyers.name': re }] })
      .select('buyers lotNumber project')
      .populate('project', 'name marketingName')
      .limit(10)
      .lean(),
  ]);
  const out = new Map();
  for (const c of fromThreads) out.set(c._id, { email: c._id, name: c.name || '', source: 'mail' });
  for (const lot of lots) {
    for (const b of lot.buyers || []) {
      const e = normalizeEmail(b.email);
      if (!e || !(re.test(e) || re.test(b.name || ''))) continue;
      const tag = `Lot ${lot.lotNumber}${lot.project ? ` · ${lot.project.marketingName || lot.project.name}` : ''}`;
      out.set(e, { email: e, name: b.name || out.get(e)?.name || '', source: 'lot', tag });
    }
  }
  res.json([...out.values()].slice(0, 10));
});

router.get('/status', async (req, res) => {
  const accounts = await MailAccount.find().sort({ isDefault: -1, createdAt: 1 }).lean();
  const unread = await EmailThread.aggregate([
    { $match: { ...VIEWS.unread } },
    { $group: { _id: '$account', threads: { $sum: 1 } } },
  ]);
  const unreadBy = new Map(unread.map((u) => [String(u._id), u.threads]));
  res.json({
    unread: unread.reduce((n, u) => n + u.threads, 0),
    accounts: accounts.map((a) => ({
      _id: a._id,
      email: a.email,
      label: a.label,
      color: a.color,
      kind: a.kind,
      enabled: a.enabled,
      isDefault: a.isDefault,
      displayName: a.displayName,
      hasSignature: Boolean(a.signatureHtml),
      unread: unreadBy.get(String(a._id)) || 0,
      sync: { state: isSyncing(a._id) ? 'syncing' : a.sync?.state, message: a.sync?.message, lastSyncAt: a.sync?.lastSyncAt, initialDone: a.sync?.initialDone },
    })),
    ai: { configured: secrets.anthropicConfigured() },
    calendly: { configured: secrets.calendlyConfigured() },
  });
});

router.post('/sync', async (req, res) => {
  const { accountId } = req.body || {};
  if (accountId && isId(accountId)) return res.json(await syncAccount(accountId, { trigger: 'manual' }));
  res.json(await syncAll({ trigger: 'manual', force: true }));
});

module.exports = router;

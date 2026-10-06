const express = require('express');
const mongoose = require('mongoose');
const KnowledgeEntry = require('../models/KnowledgeEntry');
const EmailThread = require('../models/EmailThread');
const EmailMessage = require('../models/EmailMessage');
const MailAccount = require('../models/MailAccount');
const Setting = require('../models/Setting');
const secrets = require('../services/secrets');
const { resolveScheduleTimezone } = require('../services/sendWindow');
const { selfEmailsOf } = require('../services/mail/store');
const { streamResponse } = require('../services/sse');
const { streamStyleProfile } = require('../services/ai/drafting');
const P = require('../services/ai/prompts');

const router = express.Router();
const TYPES = ['style', 'example', 'thread', 'fact'];
const MAX_CONTENT = 60_000;

const isId = (v) => mongoose.isValidObjectId(v);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shape(e) {
  return {
    _id: e._id,
    type: e.type,
    title: e.title,
    content: e.content,
    tags: e.tags,
    enabled: e.enabled,
    pinned: e.pinned,
    source: e.source,
    tokens: P.estimateTokens(e.content),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

async function stats() {
  const all = await KnowledgeEntry.find().lean();
  const enabled = all.filter((e) => e.enabled);
  const byType = Object.fromEntries(TYPES.map((t) => [t, all.filter((e) => e.type === t).length]));
  return {
    total: all.length,
    enabled: enabled.length,
    byType,
    contextTokens: P.estimateTokens(P.buildKnowledgeBlock(enabled)),
  };
}

// Who Claude writes as.
router.get('/profile', async (req, res) => {
  const s = await Setting.getSingleton();
  res.json({
    writerName: s.inbox?.writerName || '',
    writerRole: s.inbox?.writerRole || '',
    signOff: s.inbox?.signOff || '',
    ownerName: s.owner?.name || '',
  });
});

router.patch('/profile', async (req, res) => {
  const { writerName, writerRole, signOff } = req.body || {};
  const s = await Setting.getSingleton();
  s.inbox = s.inbox || {};
  if (writerName != null) s.inbox.writerName = String(writerName).slice(0, 120);
  if (writerRole != null) s.inbox.writerRole = String(writerRole).slice(0, 160);
  if (signOff != null) s.inbox.signOff = String(signOff).slice(0, 120);
  await s.save();
  res.json({ writerName: s.inbox.writerName, writerRole: s.inbox.writerRole, signOff: s.inbox.signOff });
});

router.get('/', async (req, res) => {
  const filter = {};
  if (TYPES.includes(req.query.type)) filter.type = req.query.type;
  const q = String(req.query.q || '').trim();
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: re }, { content: re }, { tags: re }];
  }
  const rows = await KnowledgeEntry.find(filter).sort({ pinned: -1, updatedAt: -1 }).lean();
  res.json({ entries: rows.map(shape), stats: await stats() });
});

function clean(body, entry = {}) {
  const out = {};
  if (body.type != null) {
    if (!TYPES.includes(body.type)) throw Object.assign(new Error('Unknown entry type.'), { status: 400 });
    out.type = body.type;
  }
  if (body.title != null) out.title = String(body.title).slice(0, 200);
  if (body.content != null) out.content = String(body.content).slice(0, MAX_CONTENT);
  if (body.tags != null) {
    out.tags = (Array.isArray(body.tags) ? body.tags : String(body.tags).split(','))
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (body.enabled != null) out.enabled = Boolean(body.enabled);
  if (body.pinned != null) out.pinned = Boolean(body.pinned);
  if (!out.title && !entry.title && out.content) out.title = out.content.split('\n')[0].slice(0, 80);
  return out;
}

router.post('/', async (req, res) => {
  try {
    const data = clean(req.body || {});
    if (!data.type) return res.status(400).json({ error: 'Pick a type.' });
    if (!String(data.content || '').trim()) return res.status(400).json({ error: 'Content is empty.' });
    const e = await KnowledgeEntry.create(data);
    res.status(201).json(shape(e));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const e = await KnowledgeEntry.findById(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  try {
    Object.assign(e, clean(req.body || {}, e));
    await e.save();
    res.json(shape(e));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const e = await KnowledgeEntry.findByIdAndDelete(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  await EmailThread.updateMany({ knowledgeEntry: e._id }, { $set: { knowledgeEntry: null } });
  res.json({ ok: true });
});

// Save a whole inbox conversation as a knowledge entry (your replies marked
// "ME"). Saving the same thread again refreshes the entry.
router.post('/from-thread', async (req, res) => {
  const { threadId, title, note, type } = req.body || {};
  if (!isId(threadId)) return res.status(400).json({ error: 'threadId required' });
  const thread = await EmailThread.findById(threadId);
  if (!thread) return res.status(404).json({ error: 'not_found' });
  const account = await MailAccount.findById(thread.account);
  const messages = await EmailMessage.find({ thread: thread._id }).sort({ date: 1 }).select('from to direction date text').lean();
  const s = await Setting.getSingleton();
  let content = P.buildKnowledgeTranscript(messages, {
    selfEmails: account ? selfEmailsOf(account) : new Set(),
    timeZone: resolveScheduleTimezone(s),
  });
  if (note) content = `Why this conversation matters: ${String(note).trim()}\n\n${content}`;
  content = content.slice(0, MAX_CONTENT);
  const entryType = type === 'example' ? 'example' : 'thread';

  let entry = thread.knowledgeEntry ? await KnowledgeEntry.findById(thread.knowledgeEntry) : null;
  if (!entry) entry = new KnowledgeEntry({ type: entryType });
  entry.type = entryType;
  entry.title = String(title || thread.subject || 'Saved conversation').slice(0, 200);
  entry.content = content;
  entry.enabled = true;
  entry.source = { thread: thread._id, account: thread.account, messageCount: messages.length, generated: false };
  await entry.save();
  thread.knowledgeEntry = entry._id;
  await thread.save();
  res.json(shape(entry));
});

// Learn the owner's voice from examples + sent mail (SSE), saved as a pinned
// style entry.
router.post('/learn-style', async (req, res) => {
  if (!secrets.anthropicConfigured()) {
    return res.status(400).json({ error: 'Claude is not connected. Add your Anthropic API key in Integrations → Claude.' });
  }
  await streamResponse(req, res, ({ emit, signal }) => streamStyleProfile({ emit, signal }));
});

module.exports = router;

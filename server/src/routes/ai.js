const express = require('express');
const mongoose = require('mongoose');
const KnowledgeEntry = require('../models/KnowledgeEntry');
const secrets = require('../services/secrets');
const claude = require('../services/ai/claude');
const { streamDraft } = require('../services/ai/drafting');
const { streamResponse } = require('../services/sse');
const { buildKnowledgeBlock, estimateTokens } = require('../services/ai/prompts');

const router = express.Router();

router.get('/status', async (req, res) => {
  const entries = await KnowledgeEntry.find({ enabled: true }).lean();
  res.json({
    configured: secrets.anthropicConfigured(),
    source: secrets.source('anthropic'),
    model: claude.MODEL,
    modelLabel: claude.MODEL_LABEL,
    effort: await claude.resolveEffort(),
    knowledge: { entries: entries.length, tokens: estimateTokens(buildKnowledgeBlock(entries)) },
  });
});

// Stream a draft (SSE). Events: meta → subject? → text… → done | error.
router.post('/draft', async (req, res) => {
  const b = req.body || {};
  const modes = ['reply', 'replyAll', 'forward', 'new', 'rewrite', 'playground'];
  const opts = {
    mode: modes.includes(b.mode) ? b.mode : 'reply',
    threadId: b.threadId && mongoose.isValidObjectId(b.threadId) ? b.threadId : null,
    accountId: b.accountId && mongoose.isValidObjectId(b.accountId) ? b.accountId : null,
    instructions: b.instructions,
    intent: b.intent,
    tone: b.tone,
    length: b.length,
    includeAvailability: Boolean(b.includeAvailability),
    eventTypeUri: b.eventTypeUri,
    currentDraft: b.currentDraft,
    to: Array.isArray(b.to) ? b.to.filter((r) => r && r.email) : [],
    subject: b.subject,
    incoming: b.incoming,
    effort: b.effort,
  };
  if (opts.mode === 'playground') opts.mode = 'reply';
  if (opts.mode === 'rewrite' && !String(opts.currentDraft || '').trim()) {
    return res.status(400).json({ error: 'There is no draft to rewrite yet.' });
  }
  if (!secrets.anthropicConfigured()) {
    return res.status(400).json({ error: 'Claude is not connected. Add your Anthropic API key in Integrations → Claude.' });
  }
  await streamResponse(req, res, ({ emit, signal }) => streamDraft(opts, { emit, signal }));
});

module.exports = router;

const express = require('express');
const env = require('../config/env');
const { handleWebhook } = require('../services/calendly');
const elevenlabs = require('../services/elevenlabs');
const ariaCall = require('../services/ariaCall');
const callQueue = require('../services/callQueue');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');

const router = express.Router();

// ElevenLabs post-call webhook — fires when an Aria conversation finishes and
// carries the transcript, summary, duration, and (sometimes) a recording URL.
// Verified via HMAC when ELEVENLABS_WEBHOOK_SECRET is set; in dev an unsigned
// payload is accepted with a logged warning. We capture the raw body (verify
// hook) because the signature is computed over the exact bytes. Idempotent per
// conversation_id inside ariaCall.applyPostCall.
router.post(
  '/elevenlabs',
  express.json({ limit: '3mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
  async (req, res) => {
    const secret = env.elevenlabs.webhookSecret;
    const verification = elevenlabs.verifyWebhookSignature({
      rawBody: req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}),
      header: req.get('elevenlabs-signature'),
      secret,
    });
    if (!verification.ok) {
      return res.status(401).json({ error: 'invalid_signature', reason: verification.reason });
    }
    if (!secret) {
      console.warn('[elevenlabs] webhook accepted unsigned — set ELEVENLABS_WEBHOOK_SECRET in production');
    }
    try {
      const normalised = elevenlabs.normalisePostCallPayload(req.body || {});
      const result = await ariaCall.applyPostCall(normalised);
      // Nudge the sequential call queue so the next call starts right away
      // instead of waiting for the worker's poll tick. Best-effort.
      callQueue.advance().catch(() => {});
      // Always 200 so ElevenLabs doesn't retry a payload we intentionally
      // ignored (unknown lot, dedup, etc.).
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  }
);

// Calendly sends a JSON payload. Verify the shared secret via a header we ask
// the user to configure on the webhook subscription (or query param fallback).
router.post('/calendly', express.json({ limit: '1mb' }), async (req, res) => {
  const secret = env.calendly.webhookSecret;
  const provided = req.get('x-webhook-secret') || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: 'bad_secret' });

  const event = req.body?.event || req.body?.type || '';
  if (!event.includes('invitee.created') && !event.includes('invitee.canceled')) {
    return res.json({ ignored: true });
  }
  try {
    const result = await handleWebhook(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Twilio inbound SMS webhook — records replies so they show up in history.
router.post('/twilio', express.urlencoded({ extended: true }), async (req, res) => {
  const { From, Body, MessageSid } = req.body || {};
  if (!From) return res.status(400).send('missing From');
  const fromDigits = String(From).replace(/\D/g, '');
  const lot = await Lot.findOne({
    'buyers.phone': { $regex: fromDigits.slice(-10), $options: 'i' },
  });
  await MessageLog.create({
    project: lot?.project || null,
    lot: lot?._id || null,
    type: 'sms',
    direction: 'in',
    to: env.twilio.from,
    subject: '',
    body: Body || '',
    status: 'received',
    providerId: MessageSid || '',
    sentAt: new Date(),
  });
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

module.exports = router;

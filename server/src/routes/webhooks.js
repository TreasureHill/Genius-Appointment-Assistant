const express = require('express');
const env = require('../config/env');
const { handleWebhook } = require('../services/calendly');
const elevenlabs = require('../services/elevenlabs');
const ariaCall = require('../services/ariaCall');
const callQueue = require('../services/callQueue');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const AlarmContract = require('../models/AlarmContract');
const { processWebhookEvent } = require('../services/contracts/webhookEvents');
const docusign = require('../services/contracts/docusign');
const envelopeSync = require('../services/contracts/envelopeSync');
const billing = require('../services/contracts/billing');
const { expectedLivemode } = require('../services/contracts/stripeClient');

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

// Stripe — alarm monitoring subscriptions. The signature is computed over the
// exact bytes, so this route takes the raw Buffer (express.raw) — it is
// mounted before the global express.json() in index.js. Fails CLOSED in
// production when the signing secret is missing (503, Stripe keeps retrying
// until it is set). In development an unsigned event is accepted with a
// warning; that is safe-ish only because billing.applyStripeEvent re-fetches
// every object from Stripe instead of trusting the payload.
// Deduped through WebhookEvent: a replay answers 200 and changes nothing; an
// event still being processed answers 409 so Stripe retries later.
router.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!env.stripe.configured) return res.status(503).json({ error: 'not_configured' });
  const secret = env.stripe.webhookSecret;
  let event;
  if (secret) {
    try {
      event = require('stripe').webhooks.constructEvent(req.body, req.get('stripe-signature') || '', secret);
    } catch {
      return res.status(400).json({ error: 'invalid_signature' });
    }
  } else {
    if (env.isProduction) return res.status(503).json({ error: 'not_configured' });
    console.warn('[stripe] webhook accepted unsigned — set STRIPE_WEBHOOK_SECRET (stripe listen prints one)');
    try {
      event = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
    } catch {
      return res.status(400).json({ error: 'invalid_payload' });
    }
  }
  if (!event || !event.id || !event.type) return res.status(400).json({ error: 'invalid_payload' });
  // A test-mode event must never touch a live install, and vice versa.
  const live = expectedLivemode();
  if (live !== null && Boolean(event.livemode) !== live) {
    return res.status(400).json({ error: 'livemode_mismatch' });
  }
  const obj = (event.data && event.data.object) || {};
  const { status, body } = await processWebhookEvent(
    { provider: 'stripe', eventId: event.id, type: event.type, objectId: obj.id || '' },
    () => billing.applyStripeEvent(event)
  );
  res.status(status).json(body);
});

// DocuSign Connect — per-envelope JSON SIM notifications for the alarm
// monitoring agreements. HMAC over the raw bytes (verify hook keeps the
// Buffer; it is never re-serialised — unlike the ElevenLabs handler above,
// there is no JSON.stringify fallback). Every configured key is tried against
// every X-DocuSign-Signature-N header (key rotation). Fails CLOSED in
// production without a key. The payload is only a hint: envelopeSync re-fetches
// the envelope from DocuSign. Processed synchronously (a few seconds, well
// inside Connect's timeout); a 500 makes Connect retry, and the poller is the
// backstop.
router.post(
  '/docusign',
  express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
  async (req, res) => {
    if (!env.docusign.configured) return res.status(503).json({ error: 'not_configured' });
    const keys = env.docusign.connectHmacKeys;
    if (keys.length) {
      const v = docusign.verifyConnectHmac({ rawBody: req.rawBody, headers: req.headers, keys });
      if (!v.ok) return res.status(401).json({ error: 'invalid_signature', reason: v.reason });
    } else if (env.isProduction) {
      return res.status(503).json({ error: 'not_configured' });
    } else {
      console.warn('[docusign] Connect message accepted unsigned — set DOCUSIGN_CONNECT_HMAC_KEYS in production');
    }
    const n = docusign.normaliseConnectPayload(req.body);
    if (!n.envelopeId) return res.status(400).json({ error: 'invalid_payload' });
    if (env.docusign.accountId && n.accountId && n.accountId !== env.docusign.accountId) {
      return res.status(400).json({ error: 'account_mismatch' });
    }
    const { status, body } = await processWebhookEvent(
      { provider: 'docusign', eventId: n.eventId, type: n.event, objectId: n.envelopeId },
      async () => {
        await AlarmContract.updateOne(
          { 'envelope.id': n.envelopeId },
          { $set: { 'envelope.lastConnectAt': new Date() } }
        );
        return envelopeSync.applyEnvelopeStatus(n.envelopeId, { actor: 'docusign' });
      }
    );
    res.status(status).json(body);
  }
);

module.exports = router;

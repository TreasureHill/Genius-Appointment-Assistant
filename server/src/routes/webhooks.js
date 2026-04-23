const express = require('express');
const env = require('../config/env');
const { handleWebhook } = require('../services/calendly');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');

const router = express.Router();

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

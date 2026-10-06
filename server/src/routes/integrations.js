const express = require('express');
const axios = require('axios');
const env = require('../config/env');
const Setting = require('../models/Setting');
const secrets = require('../services/secrets');
const { encrypt, hint } = require('../services/secretBox');
const calendlyConnect = require('../services/calendlyConnect');
const claude = require('../services/ai/claude');
const msAuth = require('../services/mail/microsoftAuth');

// API connections managed from the UI. Secrets are write-only: the API only
// ever reports whether a key is set, where it comes from, and its last four
// characters.

const router = express.Router();

router.get('/', async (req, res) => {
  const s = await Setting.getSingleton();
  const i = s.integrations || {};
  const ms = secrets.microsoftApp();
  res.json({
    appUrl: env.appUrl,
    calendly: {
      connected: secrets.calendlyConfigured(),
      source: secrets.source('calendly'),
      tokenHint: hint(secrets.calendlyToken()),
      account: i.calendly?.account || null,
      connectedAt: i.calendly?.connectedAt || null,
      health: s.calendlyHealth,
      lastSync: s.lastCalendlySync,
      defaultEventTypeUri: i.calendly?.defaultEventTypeUri || '',
      webhookUrl: `${String(env.appUrl).replace(/\/+$/, '')}/api/webhooks/calendly`,
    },
    anthropic: {
      connected: secrets.anthropicConfigured(),
      source: secrets.source('anthropic'),
      keyHint: hint(secrets.anthropicKey()),
      model: claude.MODEL,
      modelLabel: claude.MODEL_LABEL,
      effort: i.anthropic?.effort || 'medium',
      lastTest: i.anthropic?.lastTest || null,
    },
    resend: {
      connected: secrets.resendConfigured(),
      source: secrets.source('resend'),
      keyHint: hint(secrets.resendKey()),
      from: secrets.resendFrom(),
    },
    microsoft: {
      configured: secrets.microsoftConfigured(),
      source: ms.source,
      tenantId: ms.source === 'settings' ? i.microsoft?.tenantId || '' : env.microsoft.tenantId,
      clientId: ms.clientId,
      secretHint: hint(ms.clientSecret),
      redirectUri: msAuth.redirectUri(),
      scopes: msAuth.BASE_SCOPES,
    },
    smtp: { configured: env.smtp.configured, host: env.smtp.host, user: env.smtp.user, from: env.smtp.from },
  });
});

// ---- Calendly ----

router.put('/calendly', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, message: 'Paste a Calendly Personal Access Token.' });
  const r = await calendlyConnect.connect(token);
  res.status(r.ok ? 200 : 400).json(r);
});

router.patch('/calendly', async (req, res) => {
  const s = await Setting.getSingleton();
  if (req.body?.defaultEventTypeUri != null) s.integrations.calendly.defaultEventTypeUri = String(req.body.defaultEventTypeUri);
  await s.save();
  res.json({ ok: true, defaultEventTypeUri: s.integrations.calendly.defaultEventTypeUri });
});

router.post('/calendly/test', async (req, res) => {
  res.json(await calendlyConnect.refreshAccount());
});

router.delete('/calendly', async (req, res) => {
  await calendlyConnect.disconnect();
  res.json({ ok: true, stillConnectedViaEnv: secrets.calendlyConfigured() });
});

router.get('/calendly/webhooks', async (req, res) => {
  res.json(await calendlyConnect.listWebhooks());
});

router.post('/calendly/webhooks', async (req, res) => {
  const r = await calendlyConnect.registerWebhook();
  res.status(r.ok ? 200 : 400).json(r);
});

router.delete('/calendly/webhooks/:id', async (req, res) => {
  const r = await calendlyConnect.deleteWebhook(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

// ---- Claude (Anthropic) ----

router.put('/anthropic', async (req, res) => {
  const { apiKey, effort } = req.body || {};
  const s = await Setting.getSingleton();
  if (apiKey) {
    const key = String(apiKey).trim();
    const t = await claude.testKey(key);
    s.integrations.anthropic.lastTest = { ok: t.ok, message: t.message, at: new Date() };
    if (!t.ok) {
      await s.save();
      return res.status(400).json(t);
    }
    s.integrations.anthropic.apiKeyEnc = encrypt(key);
    s.integrations.anthropic.connectedAt = new Date();
  }
  if (effort != null) {
    if (!claude.EFFORTS.includes(effort)) return res.status(400).json({ ok: false, message: 'Effort must be low, medium or high.' });
    s.integrations.anthropic.effort = effort;
  }
  await s.save();
  await secrets.loadSecrets();
  res.json({ ok: true, message: s.integrations.anthropic.lastTest?.message || 'Saved.', effort: s.integrations.anthropic.effort });
});

router.post('/anthropic/test', async (req, res) => {
  const t = await claude.testKey();
  const s = await Setting.getSingleton();
  s.integrations.anthropic.lastTest = { ok: t.ok, message: t.message, at: new Date() };
  await s.save();
  res.json(t);
});

router.delete('/anthropic', async (req, res) => {
  const s = await Setting.getSingleton();
  s.integrations.anthropic.apiKeyEnc = '';
  s.integrations.anthropic.connectedAt = null;
  await s.save();
  await secrets.loadSecrets();
  res.json({ ok: true, stillConnectedViaEnv: secrets.anthropicConfigured() });
});

// ---- Resend (outgoing only) ----

async function testResend(key) {
  try {
    const { data } = await axios.get('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` }, timeout: 15_000 });
    const domains = (data?.data || []).map((d) => `${d.name}${d.status && d.status !== 'verified' ? ` (${d.status})` : ''}`);
    return { ok: true, message: domains.length ? `Connected — domains: ${domains.join(', ')}` : 'Connected — no domains verified yet.' };
  } catch (err) {
    const body = err?.response?.data || {};
    // Sending-only keys can't list domains but are fine for sending.
    if (body.name === 'restricted_api_key') return { ok: true, message: 'Connected (sending-only key).' };
    return { ok: false, message: body.message || err.message };
  }
}

router.put('/resend', async (req, res) => {
  const { apiKey, from } = req.body || {};
  const s = await Setting.getSingleton();
  let message = 'Saved.';
  if (apiKey) {
    const t = await testResend(String(apiKey).trim());
    if (!t.ok) return res.status(400).json(t);
    message = t.message;
    s.integrations.resend.apiKeyEnc = encrypt(String(apiKey).trim());
    s.integrations.resend.connectedAt = new Date();
  }
  if (from != null) s.integrations.resend.from = String(from).trim();
  await s.save();
  await secrets.loadSecrets();
  res.json({ ok: true, message });
});

router.post('/resend/test', async (req, res) => {
  if (!secrets.resendConfigured()) return res.json({ ok: false, message: 'No Resend key connected.' });
  res.json(await testResend(secrets.resendKey()));
});

router.delete('/resend', async (req, res) => {
  const s = await Setting.getSingleton();
  s.integrations.resend.apiKeyEnc = '';
  s.integrations.resend.connectedAt = null;
  await s.save();
  await secrets.loadSecrets();
  res.json({ ok: true });
});

// ---- Microsoft 365 app registration ----

router.put('/microsoft', async (req, res) => {
  const { tenantId, clientId, clientSecret } = req.body || {};
  const s = await Setting.getSingleton();
  const current = secrets.microsoftApp();
  const app = {
    tenantId: String(tenantId ?? s.integrations.microsoft?.tenantId ?? '').trim() || 'organizations',
    clientId: String(clientId ?? s.integrations.microsoft?.clientId ?? '').trim(),
    clientSecret: clientSecret ? String(clientSecret).trim() : current.source === 'settings' ? current.clientSecret : '',
  };
  if (!app.clientId || !app.clientSecret) {
    return res.status(400).json({ ok: false, message: 'Application (client) ID and client secret are both required.' });
  }
  const t = await msAuth.testApp(app);
  if (!t.ok) return res.status(400).json(t);
  s.integrations.microsoft = { tenantId: app.tenantId, clientId: app.clientId, clientSecretEnc: encrypt(app.clientSecret) };
  await s.save();
  await secrets.loadSecrets();
  res.json(t);
});

router.post('/microsoft/test', async (req, res) => {
  if (!secrets.microsoftConfigured()) return res.json({ ok: false, message: 'No app registration saved yet.' });
  res.json(await msAuth.testApp(secrets.microsoftApp()));
});

router.delete('/microsoft', async (req, res) => {
  const s = await Setting.getSingleton();
  s.integrations.microsoft = { tenantId: '', clientId: '', clientSecretEnc: '' };
  await s.save();
  await secrets.loadSecrets();
  res.json({ ok: true });
});

module.exports = router;

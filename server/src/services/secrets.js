const env = require('../config/env');
const Setting = require('../models/Setting');
const { decrypt } = require('./secretBox');

// Decrypted API keys held in memory so synchronous callers (the Calendly axios
// client, the Anthropic client factory) never touch Mongo. Loaded at boot and
// reloaded whenever a key is saved or removed in Integrations. Each getter
// prefers the key stored in Settings and falls back to .env.

const cache = {
  loaded: false,
  calendlyToken: '',
  anthropicKey: '',
  resendKey: '',
  resendFrom: '',
  calendlyWebhookSecret: '',
  msTenantId: '',
  msClientId: '',
  msClientSecret: '',
};

async function loadSecrets() {
  const s = await Setting.getSingleton();
  const i = s.integrations || {};
  cache.calendlyToken = decrypt(i.calendly?.tokenEnc);
  cache.anthropicKey = decrypt(i.anthropic?.apiKeyEnc);
  cache.resendKey = decrypt(i.resend?.apiKeyEnc);
  cache.resendFrom = i.resend?.from || '';
  cache.calendlyWebhookSecret = i.calendly?.webhookSecret || '';
  cache.msTenantId = i.microsoft?.tenantId || '';
  cache.msClientId = i.microsoft?.clientId || '';
  cache.msClientSecret = decrypt(i.microsoft?.clientSecretEnc);
  cache.loaded = true;
  return cache;
}

const calendlyToken = () => cache.calendlyToken || env.calendly.token;
const anthropicKey = () => cache.anthropicKey || env.anthropic.apiKey;
const resendKey = () => cache.resendKey || env.resend.apiKey;
const resendFrom = () => cache.resendFrom || env.resend.from;
const calendlyWebhookSecret = () => env.calendly.webhookSecret || cache.calendlyWebhookSecret;

// The Entra app used for Microsoft 365 mailboxes. Settings win as a set
// (tenant + client id + secret together) so a half-edited form can't mix two
// registrations.
function microsoftApp() {
  if (cache.msClientId) {
    return { tenantId: cache.msTenantId || 'organizations', clientId: cache.msClientId, clientSecret: cache.msClientSecret, source: 'settings' };
  }
  if (env.microsoft.clientId) {
    return { tenantId: env.microsoft.tenantId || 'organizations', clientId: env.microsoft.clientId, clientSecret: env.microsoft.clientSecret, source: 'env' };
  }
  return { tenantId: '', clientId: '', clientSecret: '', source: '' };
}

// Where each key currently comes from — 'settings', 'env', or '' (missing).
function source(kind) {
  const fromSettings = {
    calendly: cache.calendlyToken,
    anthropic: cache.anthropicKey,
    resend: cache.resendKey,
  }[kind];
  const fromEnv = { calendly: env.calendly.token, anthropic: env.anthropic.apiKey, resend: env.resend.apiKey }[kind];
  if (fromSettings) return 'settings';
  if (fromEnv) return 'env';
  return '';
}

module.exports = {
  loadSecrets,
  calendlyToken,
  anthropicKey,
  resendKey,
  resendFrom,
  calendlyWebhookSecret,
  source,
  microsoftApp,
  microsoftConfigured: () => Boolean(microsoftApp().clientId && microsoftApp().clientSecret),
  calendlyConfigured: () => Boolean(calendlyToken()),
  anthropicConfigured: () => Boolean(anthropicKey()),
  resendConfigured: () => Boolean(resendKey()),
};

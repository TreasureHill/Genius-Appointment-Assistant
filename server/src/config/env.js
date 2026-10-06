const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const toInt = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v, d = false) => {
  if (v == null) return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 4000),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/genius',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  cookieSecure: toBool(process.env.COOKIE_SECURE, false),
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    pass: process.env.ADMIN_PASS || 'changeme',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    secure: toBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
  },
  calendly: {
    token: process.env.CALENDLY_TOKEN || '',
    orgUri: process.env.CALENDLY_ORG_URI || '',
    // Optional fallback for the owner's Calendly user URI. Normally set in
    // Settings → Owner, but having an env fallback lets the reconcile script
    // run headless (e.g. in CI / a cron box) without the DB setting.
    userUri: process.env.CALENDLY_USER_URI || '',
    webhookSecret: process.env.CALENDLY_WEBHOOK_SECRET || '',
    // The Calendly Event Type Aria offers over the phone. Used to look up
    // real availability (event_type_available_times) and to mint the
    // scheduling link we text/email the homeowner to confirm. Normally set
    // in Settings → Aria; env is a fallback for headless runs.
    eventTypeUri: process.env.CALENDLY_EVENT_TYPE_URI || '',
    // API base — only overridden for tests / an egress proxy.
    apiBase: (process.env.CALENDLY_API_URL || 'https://api.calendly.com').replace(/\/+$/, ''),
  },
  // ElevenLabs Conversational AI ("Aria"). ElevenLabs places the outbound
  // call through their managed Twilio integration, so we don't need the
  // Twilio SDK for voice dispatch. The post-call webhook (transcript,
  // summary, recording) is HMAC-verified with webhookSecret.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
    agentPhoneNumberId: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || '',
    webhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET || '',
  },
  // Shared secret the ElevenLabs agent presents (x-aria-secret header) when
  // it calls our server tools mid-conversation to read Calendly availability
  // and book a slot. Leave blank to accept unsigned tool calls (dev only).
  aria: {
    toolSecret: process.env.ARIA_TOOL_SECRET || '',
  },
  // Google reviews (Reviews tab). The SerpApi key can also be pasted into
  // the Reviews tab itself (stored in Settings); this is the headless fallback.
  reviews: {
    serpapiKey: process.env.SERPAPI_KEY || '',
    placeId: process.env.GOOGLE_PLACE_ID || '',
  },
  // Claude (Anthropic API) for the inbox's AI drafting and the knowledge base.
  // The key can also be pasted in Integrations → Claude (stored encrypted in
  // Settings, which wins over this); this is the headless fallback.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },
  // Resend (resend.com) as an optional outgoing provider for the inbox.
  // Receiving still happens over IMAP — Resend inbound is not required.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM || '',
  },
  // Default mailbox for the unified inbox (read over IMAP). Optional: mailboxes
  // are normally added in Integrations → Mailboxes; when IMAP_HOST is set and
  // no mailbox exists yet, one is created at boot from these values (falling
  // back to the SMTP login for the username/password).
  imap: {
    host: process.env.IMAP_HOST || '',
    port: toInt(process.env.IMAP_PORT, 993),
    secure: toBool(process.env.IMAP_SECURE, true),
    user: process.env.IMAP_USER || '',
    pass: process.env.IMAP_PASS || '',
  },
  // Microsoft Entra app registration for Microsoft 365 mailboxes (Graph).
  // Usually entered in Integrations → Microsoft 365; these are the fallback.
  microsoft: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    // Only for Microsoft's national clouds (e.g. GCC High:
    // https://login.microsoftonline.us + https://graph.microsoft.us/v1.0).
    loginUrl: (process.env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    graphUrl: (process.env.MS_GRAPH_URL || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
  },
  // Key used to encrypt API keys / mailbox passwords stored in Mongo. Falls
  // back to JWT_SECRET. Changing it makes stored secrets unreadable (they
  // then need to be re-entered in Integrations).
  encryptionKey: process.env.APP_ENCRYPTION_KEY || '',
  defaults: {
    pacingMin: toInt(process.env.DEFAULT_PACING_MIN_SEC, 30),
    pacingMax: toInt(process.env.DEFAULT_PACING_MAX_SEC, 120),
    reminderDays: toInt(process.env.DEFAULT_REMINDER_DAYS, 14),
    maxReminders: toInt(process.env.DEFAULT_MAX_REMINDERS, 3),
  },
};

env.smtp.configured = Boolean(env.smtp.host && env.smtp.from);
env.twilio.configured = Boolean(env.twilio.sid && env.twilio.token && env.twilio.from);
env.calendly.configured = Boolean(env.calendly.token);
// `configured` = we can talk to the API at all (used for health display).
// `dispatchable` = we have everything needed to actually place a call.
env.elevenlabs.configured = Boolean(env.elevenlabs.apiKey);
env.elevenlabs.dispatchable = Boolean(
  env.elevenlabs.apiKey && env.elevenlabs.agentId && env.elevenlabs.agentPhoneNumberId
);

module.exports = env;

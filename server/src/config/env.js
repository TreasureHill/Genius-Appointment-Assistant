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
  },
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

module.exports = env;

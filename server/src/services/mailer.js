const nodemailer = require('nodemailer');
const env = require('../config/env');
const Setting = require('../models/Setting');
const { DEFAULT_FROM_NAME, buildFrom, prepareHtml, htmlToText } = require('./emailFormat');

let transporter = null;

function getTransporter() {
  if (!env.smtp.configured) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
  });
  return transporter;
}

async function verifySmtp() {
  const t = getTransporter();
  if (!t) return { ok: false, message: 'SMTP not configured' };
  try {
    await t.verify();
    return { ok: true, message: 'SMTP connection OK' };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

// The sender name from Settings → Email (SMTP). Blank there means "use the
// name in SMTP_FROM, if any"; a database hiccup falls back to the default.
async function senderName() {
  try {
    const s = await Setting.getSingleton();
    return s.emailFromName ?? DEFAULT_FROM_NAME;
  } catch {
    return DEFAULT_FROM_NAME;
  }
}

// `cc` takes the other buyers on a lot: one email, the first buyer on To and
// the rest CC'd. Every link is forced blue (so a clicked link doesn't turn
// purple), and the plain-text part is built from the HTML unless the template
// has its own.
async function sendEmail({ to, cc, subject, html, text, highImportance }) {
  const t = getTransporter();
  if (!t) throw new Error('SMTP not configured');
  const message = {
    from: buildFrom(env.smtp.from, await senderName()),
    to,
    subject,
    html: prepareHtml(html) || undefined,
    text: text || htmlToText(html || ''),
  };
  if (cc) message.cc = cc;
  if (highImportance) {
    message.priority = 'high';
    message.headers = {
      ...(message.headers || {}),
      'X-Priority': '1 (Highest)',
      'X-MSMail-Priority': 'High',
      Importance: 'High',
    };
  }
  const info = await t.sendMail(message);
  return { messageId: info.messageId };
}

module.exports = { getTransporter, verifySmtp, sendEmail, senderName };

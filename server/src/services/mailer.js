const nodemailer = require('nodemailer');
const env = require('../config/env');

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

async function sendEmail({ to, subject, html, text, highImportance }) {
  const t = getTransporter();
  if (!t) throw new Error('SMTP not configured');
  const message = {
    from: env.smtp.from,
    to,
    subject,
    html: html || undefined,
    text: text || stripHtml(html || ''),
  };
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

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { getTransporter, verifySmtp, sendEmail, stripHtml };

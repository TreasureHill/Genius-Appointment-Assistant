const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const env = require('../../config/env');
const MailAccount = require('../../models/MailAccount');
const EmailMessage = require('../../models/EmailMessage');
const EmailAttachment = require('../../models/EmailAttachment');
const { getTransporter } = require('../mailer');
const secrets = require('../secrets');
const { decrypt } = require('../secretBox');
const graph = require('./graph');
const imap = require('./imap');
const { upsertMessage } = require('./store');
const { htmlToText, escapeHtml, formatAddress, snippetFrom } = require('./text');

// Sends from a mailbox in the unified inbox. Microsoft 365 mailboxes send
// through Graph by default (the message lands in Sent Items and stays in the
// Outlook conversation); IMAP mailboxes send through their SMTP server, the
// .env SMTP login, or Resend, with In-Reply-To / References so replies thread
// for the recipient, and a copy appended to the Sent folder.

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function domainOf(email) {
  return String(email || '').split('@')[1] || 'localhost';
}

function quoteBlock(original) {
  if (!original) return '';
  const when = original.date
    ? new Date(original.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const who = escapeHtml(formatAddress(original.from));
  const body = original.html || `<div style="white-space:pre-wrap">${escapeHtml(original.text || '')}</div>`;
  return `<br><div class="gai-quote"><div>On ${escapeHtml(when)}, ${who} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`;
}

function forwardBlock(original) {
  if (!original) return '';
  const rows = [
    ['From', formatAddress(original.from)],
    ['Date', original.date ? new Date(original.date).toUTCString() : ''],
    ['Subject', original.subject || ''],
    ['To', (original.to || []).map(formatAddress).join(', ')],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${escapeHtml(v)}<br>`)
    .join('');
  return `<br><div class="gai-forward">---------- Forwarded message ----------<br>${rows}<br>${original.html || escapeHtml(original.text || '')}</div>`;
}

function smtpTransport(account) {
  const via = account.outgoing?.via;
  if (via === 'env_smtp') {
    const t = getTransporter();
    if (!t) throw httpError(400, 'The .env SMTP login is not configured.');
    return { transport: t, gmail: /gmail\.com$/i.test(env.smtp.host) };
  }
  const cfg = account.outgoing?.smtp || {};
  if (!cfg.host) throw httpError(400, 'This mailbox has no SMTP server set — edit it in Integrations → Mailboxes.');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 465,
    secure: cfg.secure !== false && Number(cfg.port) !== 587,
    auth: { user: cfg.user || account.imap?.user || account.email, pass: decrypt(cfg.passEnc) || decrypt(account.imap?.passEnc) },
  });
  return { transport, gmail: /gmail\.com$/i.test(cfg.host) };
}

async function sendViaResend(mail, attachments) {
  const key = secrets.resendKey();
  if (!key) throw httpError(400, 'Resend is not connected — add the API key in Integrations → Resend.');
  const headers = {};
  if (mail.inReplyTo) headers['In-Reply-To'] = mail.inReplyTo;
  if (mail.references?.length) headers.References = mail.references.join(' ');
  try {
    const { data } = await axios.post(
      'https://api.resend.com/emails',
      {
        from: mail.fromHeader,
        to: mail.to.map(formatAddress),
        cc: mail.cc.length ? mail.cc.map(formatAddress) : undefined,
        bcc: mail.bcc.length ? mail.bcc.map(formatAddress) : undefined,
        reply_to: mail.replyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: Object.keys(headers).length ? headers : undefined,
        attachments: attachments.length
          ? attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.data).toString('base64') }))
          : undefined,
      },
      { headers: { Authorization: `Bearer ${key}` }, timeout: 30_000 }
    );
    return data?.id || '';
  } catch (err) {
    const msg = err?.response?.data?.message || err.message;
    throw httpError(err?.response?.status === 422 || err?.response?.status === 403 ? 400 : 502, `Resend: ${msg}`);
  }
}

// opts: { accountId, mode: new|reply|replyAll|forward, replyToMessageId,
//         to, cc, bcc, subject, html, includeSignature, files: [{ filename,
//         contentType, data, size }] }
async function sendEmail(opts) {
  const account = await MailAccount.findById(opts.accountId);
  if (!account || !account.enabled) throw httpError(404, 'Mailbox not found or disabled.');
  const to = opts.to || [];
  const cc = opts.cc || [];
  const bcc = opts.bcc || [];
  if (!to.length && !cc.length && !bcc.length) throw httpError(400, 'Add at least one recipient.');
  const mode = ['new', 'reply', 'replyAll', 'forward'].includes(opts.mode) ? opts.mode : 'new';

  const original = opts.replyToMessageId
    ? await EmailMessage.findOne({ _id: opts.replyToMessageId, account: account._id })
    : null;
  if (mode !== 'new' && !original) throw httpError(404, 'The message being replied to was not found in this mailbox.');

  let bodyHtml = String(opts.html || '').trim() || '<p></p>';
  if (opts.includeSignature !== false && account.signatureHtml) {
    bodyHtml += `<br><div class="gai-signature">${account.signatureHtml}</div>`;
  }
  const files = opts.files || [];
  // Forwarding from IMAP: carry the original's attachments along.
  let forwarded = [];
  if (mode === 'forward' && original && account.kind !== 'microsoft') {
    forwarded = (await EmailAttachment.find({ message: original._id, inline: false, data: { $ne: null } }).lean()).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      data: a.data.buffer ? Buffer.from(a.data.buffer) : a.data,
      size: a.size,
    }));
  }
  const allFiles = [...files, ...forwarded];

  const via = account.kind === 'microsoft' && !['env_smtp', 'resend', 'smtp'].includes(account.outgoing?.via) ? 'graph' : account.outgoing?.via || 'smtp';
  const subject = opts.subject || original?.subject || '';
  const fromHeader = { name: account.displayName || '', address: account.email };
  const references = original ? [...(original.references || []), original.messageId].filter(Boolean).slice(-20) : [];

  let stored = {
    inReplyTo: mode === 'reply' || mode === 'replyAll' ? original?.messageId || '' : '',
    references: mode === 'new' ? [] : references,
    folder: 'sent',
    direction: 'out',
    from: { name: account.displayName || '', email: account.email },
    to,
    cc,
    bcc,
    subject,
    date: new Date(),
    isRead: true,
    hasAttachments: allFiles.length > 0,
    attachmentsLoaded: true,
    sendVia: via,
  };

  if (via === 'graph') {
    const r = await graph.send(account, {
      mode,
      replyToRemoteId: original?.remoteId,
      to,
      cc,
      bcc,
      subject,
      html: bodyHtml,
      attachments: files,
    });
    stored = {
      ...stored,
      messageId: r.messageId || `pending:${crypto.randomUUID()}`,
      remoteId: r.remoteId,
      conversationId: r.conversationId || original?.conversationId || '',
      html: r.html || bodyHtml,
    };
  } else {
    const fullHtml =
      bodyHtml + (mode === 'forward' ? forwardBlock(original) : mode === 'reply' || mode === 'replyAll' ? quoteBlock(original) : '');
    const messageId = `<${crypto.randomUUID()}@${domainOf(account.email)}>`;
    const mail = {
      from: fromHeader,
      to: to.map(formatAddress),
      cc: cc.map(formatAddress),
      bcc: bcc.map(formatAddress),
      subject,
      html: fullHtml,
      text: htmlToText(fullHtml),
      messageId,
      inReplyTo: stored.inReplyTo || undefined,
      references: stored.references.length ? stored.references : undefined,
      attachments: allFiles.map((f) => ({ filename: f.filename, content: f.data, contentType: f.contentType })),
    };
    let appendCopy = account.kind === 'imap';
    if (via === 'resend') {
      const id = await sendViaResend(
        {
          fromHeader: account.displayName ? `${account.displayName} <${account.email}>` : account.email,
          to,
          cc,
          bcc,
          replyTo: account.email,
          subject,
          html: fullHtml,
          text: mail.text,
          inReplyTo: stored.inReplyTo,
          references: stored.references,
        },
        allFiles
      );
      stored.providerId = id;
    } else {
      const { transport, gmail } = smtpTransport(account);
      try {
        const info = await transport.sendMail(mail);
        stored.providerId = info?.messageId || '';
      } catch (err) {
        throw httpError(502, `SMTP: ${err.response || err.message}`);
      }
      if (gmail) appendCopy = false; // Gmail files SMTP sends in Sent itself
    }
    if (appendCopy) {
      const raw = await new MailComposer(mail).compile().build();
      imap.appendToSent(account, raw).catch((err) => console.warn(`[mail] append to Sent failed: ${err.message}`));
    }
    stored = { ...stored, messageId, html: fullHtml, conversationId: original?.conversationId || '' };
  }

  stored.text = htmlToText(stored.html);
  stored.snippet = snippetFrom(htmlToText(bodyHtml));
  const res = await upsertMessage(account, stored, {
    origin: 'app',
    attachments: files.map((f) => ({ filename: f.filename, contentType: f.contentType, size: f.size, data: f.data })),
  });
  // Replying from the app means it's been read.
  if (original && !original.isRead) {
    original.isRead = true;
    await original.save();
  }
  return res;
}

module.exports = { sendEmail, quoteBlock, forwardBlock };

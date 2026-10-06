const axios = require('axios');
const env = require('../../config/env');
const EmailAttachment = require('../../models/EmailAttachment');
const { accessTokenFor } = require('./microsoftAuth');
const { upsertMessage, markGone, selfEmailsOf } = require('./store');
const { htmlToText, textToHtml, normalizeEmail, snippetFrom } = require('./text');

// Microsoft 365 mailboxes through Microsoft Graph: Inbox + Sent Items via
// delta queries (incremental, survives restarts), read/flag/move write-back,
// and sending through draft → send so Outlook keeps the conversation and
// files the message in Sent Items.

const GRAPH = env.microsoft.graphUrl;
const FOLDERS = [
  { role: 'inbox', wellKnown: 'inbox' },
  { role: 'sent', wellKnown: 'sentitems' },
];
const SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'isDraft',
  'flag',
  'hasAttachments',
  'bodyPreview',
  'body',
].join(',');
const GRAPH_ATTACH_MAX = 3 * 1024 * 1024; // simple attachment upload limit

function basePath(account) {
  const ms = account.microsoft || {};
  const mailbox = normalizeEmail(ms.mailbox);
  if (ms.authMode === 'app') return `/users/${encodeURIComponent(mailbox || account.email)}`;
  // A shared mailbox read by the signed-in user: anything that isn't their
  // own address. (The account's email IS the shared address, so compare with
  // the user who signed in, not with the account.)
  if (mailbox && mailbox !== normalizeEmail(ms.userPrincipalName)) {
    return `/users/${encodeURIComponent(mailbox)}`;
  }
  return '/me';
}

async function api(account) {
  const token = await accessTokenFor(account);
  return axios.create({
    baseURL: GRAPH,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 60_000,
  });
}

function describeError(err) {
  const e = err?.response?.data?.error;
  const status = err?.response?.status;
  if (status === 401) return 'Microsoft 365 rejected the access token — reconnect the mailbox.';
  if (status === 403 || e?.code === 'ErrorAccessDenied') return 'Access denied by Microsoft 365 — the app needs Mail.ReadWrite and Mail.Send (and admin consent if your tenant requires it).';
  if (status === 404 && e?.code === 'ErrorInvalidUser') return 'That mailbox was not found in Microsoft 365.';
  if (status === 429) return 'Microsoft 365 is throttling requests — sync will retry shortly.';
  return e?.message || err?.message || 'Microsoft Graph request failed';
}

const addr = (r) => ({ name: r?.emailAddress?.name || '', email: normalizeEmail(r?.emailAddress?.address) });

// Graph message -> the store's normalized message.
function normalize(account, m, role) {
  const self = selfEmailsOf(account);
  const from = addr(m.from || m.sender);
  const html = m.body?.contentType === 'html' ? m.body.content || '' : textToHtml(m.body?.content || '');
  const text = m.body?.contentType === 'html' ? htmlToText(m.body.content || '') : m.body?.content || '';
  const direction = role === 'sent' || self.has(from.email) ? 'out' : 'in';
  return {
    messageId: m.internetMessageId || `graph:${m.id}`,
    remoteId: m.id,
    conversationId: m.conversationId || '',
    folder: role,
    direction,
    from,
    to: (m.toRecipients || []).map(addr),
    cc: (m.ccRecipients || []).map(addr),
    bcc: (m.bccRecipients || []).map(addr),
    replyTo: (m.replyTo || []).map(addr),
    subject: m.subject || '',
    date: new Date((role === 'sent' ? m.sentDateTime : m.receivedDateTime) || m.receivedDateTime || Date.now()),
    html,
    text,
    snippet: snippetFrom(text || m.bodyPreview || ''),
    isRead: direction === 'out' ? true : Boolean(m.isRead),
    isFlagged: m.flag?.flagStatus === 'flagged',
    hasAttachments: Boolean(m.hasAttachments),
    attachmentsLoaded: !m.hasAttachments && !/cid:/i.test(html),
  };
}

async function syncFolder(account, http, folder, sinceDays) {
  const links = { ...(account.microsoft.deltaLinks || {}) };
  let url = links[folder.wellKnown];
  if (!url) {
    const since = new Date(Date.now() - sinceDays * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const params = new URLSearchParams({ $select: SELECT, $filter: `receivedDateTime ge ${since}` });
    url = `${basePath(account)}/mailFolders/${folder.wellKnown}/messages/delta?${params.toString()}`;
  }
  const headers = { Prefer: 'odata.maxpagesize=50, outlook.body-content-type="html"' };
  let added = 0;
  let pages = 0;
  for (;;) {
    let data;
    try {
      ({ data } = await http.get(url.replace(GRAPH, ''), { headers }));
    } catch (err) {
      // An expired delta token: start this folder over.
      const code = err?.response?.data?.error?.code || '';
      if (err?.response?.status === 410 || /syncStateNotFound|resyncRequired/i.test(code)) {
        delete links[folder.wellKnown];
        account.microsoft.deltaLinks = links;
        account.markModified('microsoft.deltaLinks');
        await account.save();
        return syncFolder(account, http, folder, sinceDays);
      }
      throw err;
    }
    pages += 1;
    for (const item of data.value || []) {
      if (item['@removed']) {
        await markGone(account, { remoteId: item.id, folder: folder.role });
        continue;
      }
      if (item.isDraft) continue;
      const res = await upsertMessage(account, normalize(account, item, folder.role));
      if (res.created) added += 1;
    }
    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
      continue;
    }
    if (data['@odata.deltaLink']) links[folder.wellKnown] = data['@odata.deltaLink'];
    break;
  }
  account.microsoft.deltaLinks = links;
  account.markModified('microsoft.deltaLinks');
  await account.save();
  return { added, pages };
}

async function sync(account, { initialSyncDays = 30 } = {}) {
  const http = await api(account);
  let added = 0;
  for (const folder of FOLDERS) {
    const r = await syncFolder(account, http, folder, initialSyncDays);
    added += r.added;
  }
  return { added };
}

// Fetch the attachment list for a message the first time it's opened, with
// inline images' bytes so the body can render them.
async function loadAttachments(account, message) {
  const http = await api(account);
  const { data } = await http.get(`${basePath(account)}/messages/${encodeURIComponent(message.remoteId)}/attachments`);
  const rows = [];
  for (const a of data.value || []) {
    if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
    const inline = Boolean(a.isInline);
    const bytes = a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : null;
    rows.push({
      account: account._id,
      message: message._id,
      filename: a.name || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (bytes ? bytes.length : 0),
      contentId: String(a.contentId || '').replace(/^<|>$/g, ''),
      inline,
      remoteId: a.id,
      data: bytes && bytes.length <= 8 * 1024 * 1024 ? bytes : null,
    });
  }
  await EmailAttachment.deleteMany({ message: message._id });
  if (rows.length) await EmailAttachment.insertMany(rows);
  message.attachmentsLoaded = true;
  message.hasAttachments = rows.some((r) => !r.inline);
  await message.save();
}

async function downloadAttachment(account, message, attachment) {
  const http = await api(account);
  const { data } = await http.get(
    `${basePath(account)}/messages/${encodeURIComponent(message.remoteId)}/attachments/${encodeURIComponent(attachment.remoteId)}/$value`,
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(data);
}

async function setFlags(account, message, { isRead, isFlagged }) {
  const http = await api(account);
  const patch = {};
  if (typeof isRead === 'boolean') patch.isRead = isRead;
  if (typeof isFlagged === 'boolean') patch.flag = { flagStatus: isFlagged ? 'flagged' : 'notFlagged' };
  await http.patch(`${basePath(account)}/messages/${encodeURIComponent(message.remoteId)}`, patch);
}

// Move to a well-known folder: archive | deleteditems | inbox. Graph gives the
// moved copy a new id.
async function move(account, message, destination) {
  const http = await api(account);
  const { data } = await http.post(`${basePath(account)}/messages/${encodeURIComponent(message.remoteId)}/move`, {
    destinationId: destination,
  });
  message.remoteId = data?.id || message.remoteId;
  message.folder = { archive: 'archive', deleteditems: 'trash', inbox: 'inbox' }[destination] || 'other';
  await message.save();
}

const recipient = (a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } });

// Insert our HTML at the top of the draft Outlook built (which already holds
// the quoted conversation, Outlook-style).
function prependToDraftBody(draftHtml, html) {
  const body = String(draftHtml || '');
  const m = body.match(/<body[^>]*>/i);
  if (!m) return `${html}${body}`;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}<div>${html}</div>${body.slice(at)}`;
}

// Send through Graph. mode: 'new' | 'reply' | 'replyAll' | 'forward'.
// Returns { messageId, remoteId, conversationId }.
async function send(account, { mode = 'new', replyToRemoteId, to, cc, bcc, subject, html, attachments = [] }) {
  for (const a of attachments) {
    if ((a.size || a.data?.length || 0) > GRAPH_ATTACH_MAX) {
      throw Object.assign(new Error(`"${a.filename}" is over 3 MB — Microsoft 365 sending supports attachments up to 3 MB each here.`), { status: 400 });
    }
  }
  const http = await api(account);
  const base = basePath(account);
  let draft;
  if (mode !== 'new' && replyToRemoteId) {
    const action = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[mode];
    ({ data: draft } = await http.post(`${base}/messages/${encodeURIComponent(replyToRemoteId)}/${action}`, {}));
    const patch = {
      body: { contentType: 'HTML', content: prependToDraftBody(draft.body?.content, html) },
      toRecipients: (to || []).map(recipient),
      ccRecipients: (cc || []).map(recipient),
      bccRecipients: (bcc || []).map(recipient),
    };
    if (subject) patch.subject = subject;
    ({ data: draft } = await http.patch(`${base}/messages/${encodeURIComponent(draft.id)}`, patch));
  } else {
    ({ data: draft } = await http.post(`${base}/messages`, {
      subject: subject || '',
      body: { contentType: 'HTML', content: html },
      toRecipients: (to || []).map(recipient),
      ccRecipients: (cc || []).map(recipient),
      bccRecipients: (bcc || []).map(recipient),
    }));
  }
  for (const a of attachments) {
    await http.post(`${base}/messages/${encodeURIComponent(draft.id)}/attachments`, {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: Buffer.from(a.data).toString('base64'),
    });
  }
  await http.post(`${base}/messages/${encodeURIComponent(draft.id)}/send`, {});
  return {
    messageId: draft.internetMessageId || '',
    remoteId: draft.id,
    conversationId: draft.conversationId || '',
    // Keep the body as sent (for replies it includes Outlook's quoted history).
    html: draft?.body?.contentType === 'html' && draft.body.content ? draft.body.content : html,
  };
}

// Who is signed in (for labelling the mailbox after OAuth).
async function whoAmI(accessToken) {
  const { data } = await axios.get(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15_000,
  });
  return data;
}

async function testMailbox(account) {
  const http = await api(account);
  const { data } = await http.get(`${basePath(account)}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`);
  return { ok: true, message: `Inbox reachable — ${data.totalItemCount ?? '?'} messages, ${data.unreadItemCount ?? '?'} unread.` };
}

module.exports = {
  sync,
  loadAttachments,
  downloadAttachment,
  setFlags,
  move,
  send,
  whoAmI,
  testMailbox,
  describeError,
  normalize,
  prependToDraftBody,
  basePath,
};

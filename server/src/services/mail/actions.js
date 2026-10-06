const EmailThread = require('../../models/EmailThread');
const EmailMessage = require('../../models/EmailMessage');
const MailAccount = require('../../models/MailAccount');
const { refreshThread } = require('./store');
const graph = require('./graph');
const imap = require('./imap');

// Owner actions on a conversation. The app's state changes immediately; the
// matching change on the mail server (read flags, flags, moves) follows in
// the background so the UI never waits on Exchange / IMAP.

function provider(account) {
  return account.kind === 'microsoft' ? graph : imap;
}

function background(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => console.warn(`[mail] ${label} failed: ${err?.response?.data?.error?.message || err.message}`));
}

async function setRead(thread, account, read) {
  const filter = { thread: thread._id, direction: 'in' };
  let targets;
  if (read) {
    targets = await EmailMessage.find({ ...filter, isRead: false });
  } else {
    // "Mark unread" flags just the latest incoming message, like mail clients.
    const latest = await EmailMessage.findOne(filter).sort({ date: -1 });
    targets = latest && latest.isRead ? [latest] : [];
  }
  if (!targets.length) return;
  await EmailMessage.updateMany({ _id: { $in: targets.map((m) => m._id) } }, { $set: { isRead: read } });
  background(`mark ${read ? 'read' : 'unread'}`, async () => {
    for (const m of targets.slice(0, 50)) await provider(account).setFlags(account, m, { isRead: read });
  });
}

async function setStar(thread, account, starred) {
  thread.starred = starred;
  let targets;
  if (starred) {
    const latest = await EmailMessage.findOne({ thread: thread._id }).sort({ date: -1 });
    targets = latest ? [latest] : [];
  } else {
    targets = await EmailMessage.find({ thread: thread._id, isFlagged: true });
  }
  await EmailMessage.updateMany({ _id: { $in: targets.map((m) => m._id) } }, { $set: { isFlagged: starred } });
  background(starred ? 'flag' : 'unflag', async () => {
    for (const m of targets.slice(0, 50)) await provider(account).setFlags(account, m, { isFlagged: starred });
  });
}

// Move the thread's messages that sit in `from` to `to` on the server.
function moveOnServer(thread, account, fromFolders, to) {
  background(`move to ${to}`, async () => {
    const msgs = await EmailMessage.find({ thread: thread._id, folder: { $in: fromFolders } });
    for (const m of msgs.slice(0, 100)) {
      if (account.kind === 'microsoft') {
        if (!m.remoteId) continue;
        await graph.move(account, m, { archive: 'archive', trash: 'deleteditems', inbox: 'inbox' }[to]);
      } else {
        await imap.move(account, m, to);
      }
    }
    await refreshThread(thread._id, account);
  });
}

// changes: { read, starred, archived, trashed }
async function updateThread(threadId, changes = {}) {
  const thread = await EmailThread.findById(threadId);
  if (!thread) return null;
  const account = await MailAccount.findById(thread.account);
  if (!account) return null;

  if (typeof changes.read === 'boolean') await setRead(thread, account, changes.read);
  if (typeof changes.starred === 'boolean') await setStar(thread, account, changes.starred);
  if (typeof changes.archived === 'boolean' && changes.archived !== thread.archived) {
    thread.archived = changes.archived;
    if (changes.archived) moveOnServer(thread, account, ['inbox'], 'archive');
    // 'other' = moved elsewhere in another client; bring those back too.
    else moveOnServer(thread, account, ['archive', 'other'], 'inbox');
  }
  if (typeof changes.trashed === 'boolean' && changes.trashed !== thread.trashed) {
    thread.trashed = changes.trashed;
    if (changes.trashed) moveOnServer(thread, account, ['inbox', 'archive'], 'trash');
    else moveOnServer(thread, account, ['trash', 'other'], 'inbox');
  }
  await thread.save();
  return refreshThread(thread._id, account);
}

module.exports = { updateThread };

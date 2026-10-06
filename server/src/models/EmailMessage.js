const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema(
  { name: { type: String, default: '' }, email: { type: String, default: '' } },
  { _id: false }
);

// One email, identified within its mailbox by its Internet Message-ID so the
// copy we store when sending and the copy the next sync reads from Sent are
// the same row.
const EmailMessageSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'MailAccount', required: true, index: true },
    thread: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailThread', index: true },
    messageId: { type: String, required: true },
    inReplyTo: { type: String, default: '' },
    references: { type: [String], default: [] },
    // Microsoft Graph message id + conversation id.
    remoteId: { type: String, default: '', index: true },
    conversationId: { type: String, default: '' },
    // IMAP location of the message.
    imapPath: { type: String, default: '' },
    uid: { type: Number, default: null },
    uidValidity: { type: String, default: '' },
    // Where it lives now: inbox | sent | archive | trash | other (moved
    // elsewhere / deleted on the server).
    folder: { type: String, default: 'inbox', index: true },
    direction: { type: String, enum: ['in', 'out'], default: 'in' },
    from: { type: AddressSchema, default: () => ({}) },
    to: { type: [AddressSchema], default: [] },
    cc: { type: [AddressSchema], default: [] },
    bcc: { type: [AddressSchema], default: [] },
    replyTo: { type: [AddressSchema], default: [] },
    subject: { type: String, default: '' },
    date: { type: Date, default: null, index: true },
    html: { type: String, default: '' },
    text: { type: String, default: '' },
    snippet: { type: String, default: '' },
    isRead: { type: Boolean, default: false },
    isFlagged: { type: Boolean, default: false },
    hasAttachments: { type: Boolean, default: false },
    // IMAP attachments are stored at sync time; Graph ones are listed the
    // first time the thread is opened.
    attachmentsLoaded: { type: Boolean, default: false },
    // 'sync' = read from the mailbox; 'app' = sent from this app.
    origin: { type: String, enum: ['sync', 'app'], default: 'sync' },
    sendVia: { type: String, default: '' },
    providerId: { type: String, default: '' },
  },
  { timestamps: true }
);

EmailMessageSchema.index({ account: 1, messageId: 1 }, { unique: true });
EmailMessageSchema.index({ thread: 1, date: 1 });
EmailMessageSchema.index({ subject: 'text', text: 'text', 'from.name': 'text', 'from.email': 'text' });

module.exports = mongoose.model('EmailMessage', EmailMessageSchema);

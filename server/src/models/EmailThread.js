const mongoose = require('mongoose');

const PersonSchema = new mongoose.Schema(
  { name: { type: String, default: '' }, email: { type: String, default: '' } },
  { _id: false }
);

// One conversation in one mailbox. Everything below `key` is derived from the
// thread's messages by services/mail/store.refreshThread, except the local
// states the owner sets (starred / archived / trashed) and the links.
const EmailThreadSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'MailAccount', required: true, index: true },
    // Microsoft: "conv:<conversationId>". IMAP: "msg:<root Message-ID>".
    key: { type: String, required: true },
    subject: { type: String, default: '' },
    normalizedSubject: { type: String, default: '', index: true },
    // Everyone on the thread except the mailbox itself.
    participants: { type: [PersonSchema], default: [] },
    lastFrom: { type: PersonSchema, default: () => ({}) },
    lastDirection: { type: String, enum: ['in', 'out'], default: 'in' },
    lastMessageAt: { type: Date, default: null, index: true },
    messageCount: { type: Number, default: 0 },
    unreadCount: { type: Number, default: 0 },
    snippet: { type: String, default: '' },
    hasAttachments: { type: Boolean, default: false },
    hasInbound: { type: Boolean, default: false },
    hasOutbound: { type: Boolean, default: false },
    // At least one message currently sits in the mailbox's Inbox folder.
    inInbox: { type: Boolean, default: false },
    starred: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    trashed: { type: Boolean, default: false },
    // Lot whose buyer is on the thread (matched by email address).
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null, index: true },
    knowledgeEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeEntry', default: null },
    // Timeline notes shown between messages (e.g. "Booked on Calendly").
    notes: {
      type: [
        new mongoose.Schema(
          {
            at: { type: Date, default: Date.now },
            kind: { type: String, default: 'note' },
            text: { type: String, default: '' },
            meta: { type: mongoose.Schema.Types.Mixed, default: {} },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, minimize: false }
);

EmailThreadSchema.index({ account: 1, key: 1 }, { unique: true });
EmailThreadSchema.index({ trashed: 1, archived: 1, inInbox: 1, lastMessageAt: -1 });
EmailThreadSchema.index({ 'participants.email': 1 });

module.exports = mongoose.model('EmailThread', EmailThreadSchema);

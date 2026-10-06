const mongoose = require('mongoose');

// What Claude learns your voice and your business from. Every enabled entry
// is sent with each drafting request (as a cached system block), so the
// owner decides exactly what the model sees.
//   style   — voice & style rules ("short paragraphs, sign off 'Best, Ali'")
//   example — an email you wrote that shows how you sound
//   thread  — a whole conversation saved from the inbox (your replies marked)
//   fact    — business facts / FAQ (hours, policies, links, pricing)
const KnowledgeEntrySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['style', 'example', 'thread', 'fact'], required: true, index: true },
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    tags: { type: [String], default: [] },
    enabled: { type: Boolean, default: true, index: true },
    pinned: { type: Boolean, default: false },
    source: {
      thread: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailThread', default: null },
      account: { type: mongoose.Schema.Types.ObjectId, ref: 'MailAccount', default: null },
      messageCount: { type: Number, default: 0 },
      generated: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

KnowledgeEntrySchema.index({ title: 'text', content: 'text', tags: 'text' });

module.exports = mongoose.model('KnowledgeEntry', KnowledgeEntrySchema);

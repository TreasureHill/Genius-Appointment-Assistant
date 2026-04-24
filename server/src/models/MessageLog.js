const mongoose = require('mongoose');

const MessageLogSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', index: true },
    rep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep', default: null },
    buyerIndex: { type: Number, default: null },
    type: { type: String, enum: ['email', 'sms', 'calendly'], required: true, index: true },
    direction: { type: String, enum: ['out', 'in'], default: 'out', index: true },
    to: { type: String, default: '' },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    status: {
      type: String,
      enum: ['queued', 'sending', 'sent', 'failed', 'delivered', 'received'],
      default: 'queued',
      index: true,
    },
    providerId: { type: String, default: '' },
    error: { type: String, default: '' },
    scheduledFor: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    isReminder: { type: Boolean, default: false },
    reminderIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

MessageLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('MessageLog', MessageLogSchema);

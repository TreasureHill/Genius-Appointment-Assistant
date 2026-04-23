const mongoose = require('mongoose');

const OutboxSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', required: true, index: true },
    buyerIndex: { type: Number, required: true },
    type: { type: String, enum: ['email', 'sms'], required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    to: { type: String, required: true },
    renderedSubject: { type: String, default: '' },
    renderedBody: { type: String, default: '' },
    renderedText: { type: String, default: '' },
    sendAfter: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    isReminder: { type: Boolean, default: false },
    reminderIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Outbox', OutboxSchema);

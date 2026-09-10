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
    // The lot is the unit of sending. `sendGroup` ties together every row of
    // one send (lot × channel × round): the single email addressed to all
    // buyers, or the one text per phone that go out together. `recipients`
    // lists who this row goes to (several for a per-lot email).
    sendGroup: { type: String, default: '', index: true },
    recipients: {
      type: [
        new mongoose.Schema(
          {
            buyerIndex: { type: Number, default: null },
            role: { type: String, default: '' },
            name: { type: String, default: '' },
            address: { type: String, default: '' },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // Set by "Send now" on the Queue / lot page: skip the send window and any
    // reminder hold and go out on the next worker tick. Only the global
    // "Pause sending" switch still stops it.
    sendNow: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Outbox', OutboxSchema);

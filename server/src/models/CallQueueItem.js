const mongoose = require('mongoose');

// One entry in the sequential Aria call queue. The queue worker dials these
// FIFO, one at a time — a new call only starts once the previous one reaches a
// terminal state (webhook or poll-detected). History rows (completed / failed /
// cancelled) are kept for the queue panel + auditing.
const CallQueueItemSchema = new mongoose.Schema(
  {
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', required: true, index: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    status: {
      type: String,
      enum: ['queued', 'calling', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    buyerRole: { type: String, default: '' },
    conversationId: { type: String, default: '' },
    outcome: { type: String, default: '' },
    error: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CallQueueItemSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('CallQueueItem', CallQueueItemSchema);

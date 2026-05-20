const mongoose = require('mongoose');

// Per-lot audit log: status changes and other significant lifecycle events.
// Sits alongside MessageLog — together they form the unified per-lot timeline.
const LotEventSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', index: true, required: true },
    type: { type: String, enum: ['status_change'], default: 'status_change', index: true },
    fromStatus: { type: String, default: '' },
    toStatus: { type: String, default: '' },
    // Where the change came from. 'user' = explicit owner action via the UI;
    // the rest are background workers / system events.
    actor: {
      type: String,
      enum: ['user', 'sender_worker', 'completion_worker', 'calendly_sync', 'calendly_map', 'system'],
      default: 'system',
      index: true,
    },
    message: { type: String, default: '' },
  },
  { timestamps: true }
);

LotEventSchema.index({ lot: 1, createdAt: -1 });

module.exports = mongoose.model('LotEvent', LotEventSchema);

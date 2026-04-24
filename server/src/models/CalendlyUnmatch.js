const mongoose = require('mongoose');

const CalendlyUnmatchSchema = new mongoose.Schema(
  {
    eventUri: { type: String, required: true, index: true },
    eventName: { type: String, default: '' },
    eventStartTime: { type: Date, default: null },
    inviteeEmail: { type: String, required: true, lowercase: true, trim: true },
    inviteeName: { type: String, default: '' },
    inviteeStatus: { type: String, default: '' },
    rep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep', default: null },
    repName: { type: String, default: '' },
    status: {
      type: String,
      enum: ['unmatched', 'mapped', 'ignored'],
      default: 'unmatched',
      index: true,
    },
    mappedLot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', default: null },
    mappedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

CalendlyUnmatchSchema.index({ eventUri: 1, inviteeEmail: 1 }, { unique: true });

module.exports = mongoose.model('CalendlyUnmatch', CalendlyUnmatchSchema);

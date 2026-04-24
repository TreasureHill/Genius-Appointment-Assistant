const mongoose = require('mongoose');

const BuyerSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['buyer', 'coBuyer', 'thirdBuyer'], required: true },
    name: { type: String, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    optedOut: { type: Boolean, default: false },
  },
  { _id: false }
);

const LOT_STATUSES = ['pending', 'contacted', 'scheduled', 'booked', 'opted_out'];

const LotSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    lotNumber: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    buyers: { type: [BuyerSchema], default: [] },
    assignedRep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep', default: null },
    status: { type: String, enum: LOT_STATUSES, default: 'pending', index: true },
    reminderCount: { type: Number, default: 0 },
    lastContactedAt: { type: Date, default: null },
    nextReminderAt: { type: Date, default: null },
    notes: { type: String, default: '' },
    calendlyWarning: { type: String, default: '' },
    calendlyEventUri: { type: String, default: '' },
  },
  { timestamps: true }
);

LotSchema.index({ project: 1, lotNumber: 1 }, { unique: true });
LotSchema.index({ assignedRep: 1 });
LotSchema.index({ 'buyers.email': 1 });

LotSchema.statics.STATUSES = LOT_STATUSES;
LotSchema.statics.STOP_STATUSES = ['scheduled', 'booked', 'opted_out'];

module.exports = mongoose.model('Lot', LotSchema);

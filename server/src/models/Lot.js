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

const LOT_STATUSES = ['pending', 'contacted', 'scheduled', 'completed', 'opted_out'];

const LotSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    lotNumber: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    buyers: { type: [BuyerSchema], default: [] },
    status: { type: String, enum: LOT_STATUSES, default: 'pending', index: true },
    importBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportBatch', default: null, index: true },
    reminderCount: { type: Number, default: 0 },
    lastContactedAt: { type: Date, default: null },
    nextReminderAt: { type: Date, default: null },
    notes: { type: String, default: '' },
    calendlyWarning: { type: String, default: '' },
    calendlyEventUri: { type: String, default: '' },
    calendlyEvent: {
      name: { type: String, default: '' },
      startTime: { type: Date, default: null },
      endTime: { type: Date, default: null },
      inviteeName: { type: String, default: '' },
      inviteeEmail: { type: String, default: '' },
      inviteeStatus: { type: String, default: '' },
      matchedBuyerRole: { type: String, default: '' },
      location: { type: String, default: '' },
      rescheduleUrl: { type: String, default: '' },
      cancelUrl: { type: String, default: '' },
      lastSyncedAt: { type: Date, default: null },
      // Set when Aria booked this slot over the phone (see services/ariaCall).
      // The lot flips to 'scheduled' immediately; `schedulingUrl` is the
      // Calendly link we text/email the homeowner to lock in a real event,
      // which the normal webhook/poller then reconciles. `calendlyEventUri`
      // stays empty until that happens, so the cancellation handler (which
      // keys off the event URI) never touches an Aria-held slot.
      bookedByAria: { type: Boolean, default: false },
      schedulingUrl: { type: String, default: '' },
    },
    // Latest outbound voice call placed by Aria (ElevenLabs Conversational
    // AI). Dispatch sets status='calling' + conversationId; the post-call
    // webhook fills in duration, summary, transcript, and outcome. The
    // recording itself is streamed on demand from ElevenLabs via
    // GET /api/lots/:id/recording (most agents don't ship a public URL).
    call: {
      status: {
        type: String,
        enum: ['idle', 'queued', 'calling', 'completed', 'voicemail', 'no_answer', 'failed'],
        default: 'idle',
      },
      conversationId: { type: String, default: '' },
      toNumber: { type: String, default: '' },
      toBuyerRole: { type: String, default: '' },
      startedAt: { type: Date, default: null },
      endedAt: { type: Date, default: null },
      durationSec: { type: Number, default: 0 },
      summary: { type: String, default: '' },
      transcript: { type: String, default: '' },
      recordingUrl: { type: String, default: '' },
      // Outcome as classified from the transcript / ElevenLabs analysis.
      outcome: { type: String, default: '' },
      // Set true once the agent's book_appointment tool fired during the call.
      booked: { type: Boolean, default: false },
      attempts: { type: Number, default: 0 },
    },
    bounceCount: { type: Number, default: 0 },
    lastBounceAt: { type: Date, default: null },
    lastBounceError: { type: String, default: '' },
  },
  { timestamps: true }
);

LotSchema.index({ project: 1, lotNumber: 1 }, { unique: true });
LotSchema.index({ 'buyers.email': 1 });

LotSchema.statics.STATUSES = LOT_STATUSES;
LotSchema.statics.STOP_STATUSES = ['scheduled', 'completed', 'opted_out'];

module.exports = mongoose.model('Lot', LotSchema);

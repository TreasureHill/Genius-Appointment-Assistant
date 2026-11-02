const mongoose = require('mongoose');

// Idempotency ledger for incoming Stripe / DocuSign webhooks. One row per
// provider event, claimed before processing (services/contracts/webhookEvents).
// Every downstream write is also an upsert or compare-and-set, so this is the
// first line of defence, not the only one. Rows expire after 90 days.
//
// eventId: Stripe = event.id (evt_…); DocuSign = sha256 of
// envelopeId|event|generatedDateTime|recipientId (docusign.normaliseConnectPayload).
const WebhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['stripe', 'docusign'], required: true },
    eventId: { type: String, required: true },
    type: { type: String, default: '' }, // invoice.paid, envelope-completed, …
    objectId: { type: String, default: '' }, // in_…, sub_…, envelope id — what to re-fetch on retry
    status: { type: String, enum: ['processing', 'processed', 'failed', 'ignored'], default: 'processing', index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
    receivedAt: { type: Date, default: Date.now },
    // When the current processing attempt started (stale after 5 min).
    startedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

WebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
WebhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('WebhookEvent', WebhookEventSchema);

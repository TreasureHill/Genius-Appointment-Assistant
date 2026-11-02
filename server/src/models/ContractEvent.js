const mongoose = require('mongoose');

// Per-contract history timeline (the full story; LotEvent only gets the
// milestones — see services/contracts/eventLogger). Write through
// eventLogger.logContractEvent, never directly, so milestones are mirrored.
const CONTRACT_EVENT_TYPES = [
  'created',
  'updated',
  'sent',
  'resent',
  'delivered',
  'recipient_signed',
  'completed',
  'declined',
  'voided',
  'regenerated',
  'paper_signed',
  'documents_stored',
  'document_uploaded',
  'package_set',
  'package_missing',
  'invite_sent',
  'portal_login',
  'password_set',
  'checkout_started',
  'checkout_completed',
  'checkout_expired',
  'subscription_status',
  'activated',
  'payment_succeeded',
  'payment_failed',
  'payment_refunded',
  'reminder_sent',
  'card_expiry_notice',
  'nudge_sent',
  'invoice_emailed',
  'email_sent',
  'email_failed',
  'canceled',
  'reconcile_fix',
  'admin_action',
  'alert',
  'note',
];

const CONTRACT_EVENT_ACTORS = [
  'user', // staff, via the admin UI
  'homeowner', // via the portal
  'docusign', // Connect webhook
  'docusign_poller',
  'stripe', // Stripe webhook
  'stripe_reconciler',
  'reminder_worker',
  'system',
];

const ContractEventSchema = new mongoose.Schema(
  {
    contract: { type: mongoose.Schema.Types.ObjectId, ref: 'AlarmContract', required: true },
    lot: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot', index: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    type: { type: String, enum: CONTRACT_EVENT_TYPES, required: true, index: true },
    fromStatus: { type: String, default: '' },
    toStatus: { type: String, default: '' },
    actor: { type: String, enum: CONTRACT_EVENT_ACTORS, default: 'system' },
    // Staff username / homeowner email when the actor is a person.
    actorName: { type: String, default: '' },
    message: { type: String, default: '' },
    // Small structured extras (ids, amounts, kinds). Never secrets, tokens or
    // full provider payloads.
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

ContractEventSchema.index({ contract: 1, createdAt: -1 });

ContractEventSchema.statics.TYPES = CONTRACT_EVENT_TYPES;
ContractEventSchema.statics.ACTORS = CONTRACT_EVENT_ACTORS;

module.exports = mongoose.model('ContractEvent', ContractEventSchema);

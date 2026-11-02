const mongoose = require('mongoose');
const {
  CONTRACT_STATUSES,
  ENVELOPE_STATUSES,
  BILLING_STATUSES,
  deriveContractStatus,
} = require('../services/contracts/status');
const { PACKAGE_KEYS } = require('../services/contracts/pricing');

const { ObjectId } = mongoose.Schema.Types;

// Alarm monitoring contract: one per lot at a time (isCurrent), signed through
// DocuSign (or uploaded on paper) and billed monthly through Stripe.
//
// `status` is derived from envelope.status + billing.status by
// services/contracts/status.deriveContractStatus and recomputed on every
// save(). Code that writes with updateOne / findOneAndUpdate (compare-and-set
// claims) must call AlarmContract.refreshStatus(id) afterwards.

const SIGNER_STATUSES = ['', 'created', 'sent', 'delivered', 'signed', 'completed', 'declined', 'autoresponded'];

const PurchaserSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['buyer', 'coBuyer', 'thirdBuyer'], default: 'buyer' },
    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    phone: { type: String, default: '', trim: true },
    // Unticked in the send dialog = listed on the agreement but not a signer.
    signs: { type: Boolean, default: true },
    // DocuSign recipient bookkeeping, filled when the envelope is created.
    recipientId: { type: String, default: '' },
    routingOrder: { type: Number, default: null },
    clientUserId: { type: String, default: '' }, // in-person (embedded) signing only
    signStatus: { type: String, enum: SIGNER_STATUSES, default: '' },
    deliveredAt: { type: Date, default: null },
    signedAt: { type: Date, default: null },
    declinedReason: { type: String, default: '' },
  },
  { _id: false }
);

const PreviousEnvelopeSchema = new mongoose.Schema(
  {
    id: { type: String, default: '' },
    status: { type: String, default: '' },
    reason: { type: String, default: '' },
    at: { type: Date, default: null },
  },
  { _id: false }
);

const AlarmContractSchema = new mongoose.Schema(
  {
    // ---- Identity -------------------------------------------------------
    number: { type: String, required: true, unique: true }, // GA-2026-00042
    project: { type: ObjectId, ref: 'Project', required: true, index: true },
    lot: { type: ObjectId, ref: 'Lot', required: true, index: true },
    // Exactly one current contract per lot (partial unique index below).
    // Regenerate after a decline/void flips the old one to false.
    isCurrent: { type: Boolean, default: true },
    regeneratedFrom: { type: ObjectId, ref: 'AlarmContract', default: null },

    // ---- Property snapshot (printed on the PDF; frozen once sent) ---------
    property: {
      projectName: { type: String, default: '' },
      model: { type: String, default: '' },
      lotNumber: { type: String, default: '' },
      address: { type: String, default: '' },
      closingDate: { type: Date, default: null },
    },

    // ---- Signing ----------------------------------------------------------
    purchasers: { type: [PurchaserSchema], default: [] },
    signingMode: { type: String, enum: ['remote', 'in_person', 'paper'], default: 'remote' },
    // When the agreement was fully signed (envelope completedAt, or the date
    // entered for a paper upload). Contract start for awaiting_payment rows.
    signedAt: { type: Date, default: null },

    // ---- Package + price ----------------------------------------------------
    // Chosen by the primary purchaser inside DocuSign (radio group), or set by
    // staff for paper / package_missing contracts.
    package: { type: String, enum: [...PACKAGE_KEYS, null], default: null },
    packageChosenAt: { type: Date, default: null },
    packageSource: { type: String, enum: ['', 'docusign', 'admin', 'paper'], default: '' },
    pricing: {
      unitCents: { type: Number, default: null },
      taxBps: { type: Number, default: 1300 },
      taxCents: { type: Number, default: null },
      totalCents: { type: Number, default: null },
      currency: { type: String, default: 'cad' },
    },
    // A signed contract that needs a human before it can move on. Blocks
    // checkout and shows a red alert.
    needsAttention: { type: String, enum: ['', 'package_missing'], default: '' },

    // ---- DocuSign mirror --------------------------------------------------
    envelope: {
      id: { type: String, default: undefined }, // unique sparse index below
      status: { type: String, enum: [...ENVELOPE_STATUSES, null], default: null },
      // Send claim: draft → (sendClaimedAt set) → sent. A double click can't
      // create two envelopes; cleared on rollback.
      sendClaimedAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      declinedAt: { type: Date, default: null },
      declinedReason: { type: String, default: '' },
      voidedAt: { type: Date, default: null },
      voidedReason: { type: String, default: '' },
      lastConnectAt: { type: Date, default: null },
      lastSyncedAt: { type: Date, default: null },
      // Completion tail claim (envelopeSync.completeEnvelope). Stale after 10
      // min so the poller can retry a crashed run; DoneAt = all steps finished.
      completionClaimedAt: { type: Date, default: null },
      completionDoneAt: { type: Date, default: null },
    },
    previousEnvelopes: { type: [PreviousEnvelopeSchema], default: [] },

    // ---- Stored PDFs (ContractDocument refs) --------------------------------
    documents: {
      unsigned: { type: ObjectId, ref: 'ContractDocument', default: null },
      signed: { type: ObjectId, ref: 'ContractDocument', default: null },
      certificate: { type: ObjectId, ref: 'ContractDocument', default: null },
    },

    // ---- Stripe mirror ------------------------------------------------------
    // Aggregates (paidCount … consecutiveMissed) are RECOMPUTED from
    // ContractPayment by billing.recomputeBillingAggregates — never $inc'd, so
    // webhook replays can't double count.
    billing: {
      status: { type: String, enum: BILLING_STATUSES, default: 'none' },
      customerId: { type: String, default: '', index: true },
      subscriptionId: { type: String, default: undefined }, // unique sparse index below
      priceId: { type: String, default: '' },
      checkoutSessionId: { type: String, default: '' },
      checkoutExpiresAt: { type: Date, default: null },
      startedAt: { type: Date, default: null },
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null }, // = next charge date
      cancelAtPeriodEnd: { type: Boolean, default: false },
      canceledAt: { type: Date, default: null },
      endedAt: { type: Date, default: null },
      pmBrand: { type: String, default: '' },
      pmLast4: { type: String, default: '' },
      pmExpMonth: { type: Number, default: null },
      pmExpYear: { type: Number, default: null },
      firstPaidAt: { type: Date, default: null },
      lastPaidAt: { type: Date, default: null },
      paidCount: { type: Number, default: 0 },
      totalPaidCents: { type: Number, default: 0 }, // net of refunds, incl. tax
      totalTaxCents: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 }, // invoices with ≥1 failed attempt
      missedCount: { type: Number, default: 0 }, // billing periods currently missed
      missedOpenCents: { type: Number, default: 0 },
      consecutiveMissed: { type: Number, default: 0 }, // newest-first run of missed periods
      lastFailureAt: { type: Date, default: null },
      lastFailureMessage: { type: String, default: '' },
      lastReconciledAt: { type: Date, default: null },
      // When the subscription last written here was read from Stripe; an
      // older read never overwrites a newer one (billing.js READ_AT).
      subscriptionReadAt: { type: Date, default: null },
    },

    // ---- Derived status (see header) ----------------------------------------
    status: { type: String, enum: CONTRACT_STATUSES, default: 'draft', index: true },

    // ---- Toggles + reminder bookkeeping -------------------------------------
    reminders: {
      enabled: { type: Boolean, default: true }, // admin or homeowner can turn off
      // Claim for the upcoming-payment email: the period end we last reminded
      // about (one reminder per billing period).
      lastRemindedPeriodEnd: { type: Date, default: null },
      lastRemindedAt: { type: Date, default: null },
      // "MM/YYYY" of the card we last sent an expiry notice for.
      lastCardExpiryNoticeFor: { type: String, default: '' },
    },
    invoiceEmails: {
      enabled: { type: Boolean, default: true },
    },
    portal: {
      invitedAt: { type: Date, default: null }, // welcome-email claim
      inviteCount: { type: Number, default: 0 },
      // Automatic welcome attempts where nothing went out (SMTP down …); the
      // contract tail worker backs off on these. Reset by a successful send.
      inviteFailures: { type: Number, default: 0 },
      lastInviteFailureAt: { type: Date, default: null },
      firstLoginAt: { type: Date, default: null },
    },
    paymentSetupNudgeSentAt: { type: Date, default: null },

    // ---- Audit ----------------------------------------------------------------
    termsVersion: { type: String, default: '' },
    notes: { type: String, default: '' },
    createdBy: { type: String, default: '' },
    canceledBy: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);

AlarmContractSchema.index({ lot: 1 }, { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_per_lot' });
AlarmContractSchema.index({ 'envelope.id': 1 }, { unique: true, sparse: true });
AlarmContractSchema.index({ 'billing.subscriptionId': 1 }, { unique: true, sparse: true });
AlarmContractSchema.index({ lot: 1, createdAt: -1 });
AlarmContractSchema.index({ status: 1, 'billing.currentPeriodEnd': 1 });
AlarmContractSchema.index({ project: 1, status: 1 });

// Keep the stored status in step with the mirrors on every save().
AlarmContractSchema.pre('save', function deriveStatus(next) {
  this.status = deriveContractStatus(this);
  next();
});

// Recompute + persist after an atomic update (updateOne / findOneAndUpdate
// bypass the save hook). Returns { from, to, changed }. Compare-and-set on the
// old status so two concurrent refreshes can't fight.
AlarmContractSchema.statics.refreshStatus = async function refreshStatus(id) {
  const c = await this.findById(id).select('status envelope.status billing.status').lean();
  if (!c) return { from: null, to: null, changed: false };
  const to = deriveContractStatus(c);
  if (to === c.status) return { from: c.status, to, changed: false };
  const r = await this.updateOne({ _id: id, status: c.status }, { $set: { status: to } });
  return { from: c.status, to, changed: r.modifiedCount > 0 };
};

// Pure: "GA-2026-00042".
AlarmContractSchema.statics.formatNumber = function formatNumber(seq, date = new Date()) {
  return `GA-${date.getUTCFullYear()}-${String(seq).padStart(5, '0')}`;
};

// Allocate the next contract number from the Setting counter ($inc is atomic,
// so concurrent creates never share a number).
AlarmContractSchema.statics.allocateNumber = async function allocateNumber(date = new Date()) {
  const Setting = mongoose.model('Setting');
  await Setting.getSingleton(); // make sure the singleton exists
  const s = await Setting.findOneAndUpdate(
    { key: 'singleton' },
    { $inc: { 'alarm.contractSeq': 1 } },
    { new: true, projection: { 'alarm.contractSeq': 1 } }
  ).lean();
  return this.formatNumber(s.alarm.contractSeq, date);
};

AlarmContractSchema.statics.SIGNER_STATUSES = SIGNER_STATUSES;

module.exports = mongoose.model('AlarmContract', AlarmContractSchema);

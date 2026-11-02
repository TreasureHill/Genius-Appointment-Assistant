const mongoose = require('mongoose');

// Local mirror of one Stripe invoice for an alarm monitoring contract. Upserted
// by billing.applyStripeEvent / reconcileContract (keyed on stripeInvoiceId),
// so replays and the nightly reconcile converge on the same rows. Contract
// billing aggregates are recomputed from these rows.
const EmailClaimSchema = new mongoose.Schema(
  {
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
  },
  { _id: false }
);

const ContractPaymentSchema = new mongoose.Schema(
  {
    contract: { type: mongoose.Schema.Types.ObjectId, ref: 'AlarmContract', required: true, index: true },
    stripeInvoiceId: { type: String, required: true, unique: true },
    stripeCustomerId: { type: String, default: '' },
    stripeSubscriptionId: { type: String, default: '' },
    number: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'open', 'paid', 'uncollectible', 'void'], default: 'draft', index: true },
    // subscription_create | subscription_cycle | subscription_update | manual …
    billingReason: { type: String, default: '' },
    attempted: { type: Boolean, default: false },
    attemptCount: { type: Number, default: 0 },
    nextPaymentAttempt: { type: Date, default: null },
    // Amounts in cents.
    subtotalCents: { type: Number, default: 0 },
    taxCents: { type: Number, default: 0 },
    totalCents: { type: Number, default: 0 },
    amountDueCents: { type: Number, default: 0 },
    amountPaidCents: { type: Number, default: 0 },
    amountRemainingCents: { type: Number, default: 0 },
    amountRefundedCents: { type: Number, default: 0 },
    currency: { type: String, default: 'cad' },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    invoiceCreatedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    hostedInvoiceUrl: { type: String, default: '' },
    invoicePdfUrl: { type: String, default: '' },
    failureMessage: { type: String, default: '' },
    // When this invoice was read from Stripe for the last write; an older read
    // never overwrites a newer one (billing.js READ_AT / upsertPayment).
    stripeReadAt: { type: Date, default: null },
    // Derived by billing.isMissed() on every upsert (indexed for the dashboard):
    // an attempted open invoice with money still owing, or uncollectible.
    missed: { type: Boolean, default: false, index: true },
    // Total differs from contract.pricing.totalCents on a subscription invoice.
    // Shown as a dashboard alert; nothing is blocked.
    amountMismatch: { type: Boolean, default: false },
    // Claims for our own emails (receipt on invoice.paid, failure on
    // invoice.payment_failed). Claim → send → sentAt; error releases the claim
    // and the reconciler retries up to 3 attempts.
    receiptEmail: { type: EmailClaimSchema, default: () => ({}) },
    failureEmail: { type: EmailClaimSchema, default: () => ({}) },
  },
  { timestamps: true }
);

ContractPaymentSchema.index({ contract: 1, periodStart: -1 });
ContractPaymentSchema.index({ status: 1, paidAt: -1 });

module.exports = mongoose.model('ContractPayment', ContractPaymentSchema);

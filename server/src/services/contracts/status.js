// Contract state machine — pure functions only (no DB, no network).
//
// A contract's `status` is never set directly. It is DERIVED from the two
// provider mirrors, `envelope.status` (DocuSign) and `billing.status`
// (Stripe), so the signing half and the billing half can never disagree.
// The derived value is stored on AlarmContract only so it can be queried and
// indexed; AlarmContract recomputes it on every save (see the model).
//
//   draft ──send──▶ sent ──completed──▶ awaiting_payment ──first invoice──▶ active
//                    ├─ declined                          active ⇄ past_due → unpaid
//                    └─ voided                            active|past_due|unpaid → canceled

const { contractError } = require('./errors');

const CONTRACT_STATUSES = Object.freeze([
  'draft',
  'sent',
  'declined',
  'voided',
  'awaiting_payment',
  'active',
  'past_due',
  'unpaid',
  'canceled',
]);

// DocuSign envelope statuses we mirror. ('sent' covers "emailed, not opened";
// 'delivered' = a signer opened it.)
const ENVELOPE_STATUSES = Object.freeze(['created', 'sent', 'delivered', 'completed', 'declined', 'voided']);

// Envelope status only moves forward. The three terminal states share the top
// rank, so once one is reached nothing (not even another terminal state) can
// replace it.
const ENVELOPE_RANK = Object.freeze({ created: 0, sent: 1, delivered: 2, completed: 3, declined: 3, voided: 3 });
const TERMINAL_ENVELOPE_STATUSES = Object.freeze(['completed', 'declined', 'voided']);

// Our mirror of the Stripe subscription lifecycle. 'none' = no checkout yet;
// 'checkout_open' = a Checkout Session exists and has not completed/expired.
const BILLING_STATUSES = Object.freeze([
  'none',
  'checkout_open',
  'incomplete',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete_expired',
  'paused',
]);

// A subscription in one of these is "live": a second checkout must be refused
// (already_subscribed).
const LIVE_BILLING_STATUSES = Object.freeze(['incomplete', 'active', 'past_due', 'unpaid', 'paused']);

function envelopeRank(status) {
  return Object.prototype.hasOwnProperty.call(ENVELOPE_RANK, status) ? ENVELOPE_RANK[status] : -1;
}

// True when moving the mirror from `from` to `to` is a forward step. A missing
// `from` (never synced) accepts anything known.
function canAdvanceEnvelope(from, to) {
  if (envelopeRank(to) < 0) return false;
  if (!from) return true;
  if (TERMINAL_ENVELOPE_STATUSES.includes(from)) return false;
  return envelopeRank(to) > envelopeRank(from);
}

// The values `envelope.status` may currently hold for a compare-and-set write
// to `to` to be allowed. Includes null (never synced). Use as
//   { 'envelope.status': { $in: envelopeStatusesBelow(to) } }
function envelopeStatusesBelow(to) {
  const r = envelopeRank(to);
  if (r < 0) return [];
  return [null, ...ENVELOPE_STATUSES.filter((s) => envelopeRank(s) < r)];
}

// Stripe subscription.status → our billing.status. Unknown values return null
// (caller should leave the mirror alone and log).
function mapStripeSubStatus(s) {
  switch (s) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
      return 'incomplete_expired';
    case 'paused':
      return 'paused';
    default:
      return null;
  }
}

// The one derivation. Accepts a contract (doc or plain object) or just
// { envelope, billing }.
function deriveContractStatus({ envelope, billing } = {}) {
  const b = (billing && billing.status) || 'none';
  if (b === 'active' || b === 'past_due' || b === 'unpaid' || b === 'canceled') return b;
  // The first Checkout payment never went through and Stripe gave up on the
  // subscription: the contract is over (staff regenerate if needed).
  if (b === 'incomplete_expired') return 'canceled';
  // Paused subscriptions don't bill; surface them with the delinquent ones so
  // staff notice.
  if (b === 'paused') return 'past_due';
  const e = envelope && envelope.status;
  if (e === 'completed') return 'awaiting_payment'; // includes checkout_open / incomplete
  if (e === 'declined' || e === 'voided') return e;
  if (e === 'sent' || e === 'delivered') return 'sent';
  return 'draft';
}

// Label + badge class (existing .badge.* classes in client/src/styles.css).
// The client keeps a mirror copy in components/contracts/bits.jsx.
const CONTRACT_STATUS_META = Object.freeze({
  draft: { label: 'Draft', badge: 'pending' },
  sent: { label: 'Awaiting signature', badge: 'contacted' },
  declined: { label: 'Declined', badge: 'opted_out' },
  voided: { label: 'Voided', badge: 'completed' },
  awaiting_payment: { label: 'Awaiting payment setup', badge: 'scheduled' },
  active: { label: 'Active', badge: 'ok' },
  past_due: { label: 'Past due', badge: 'err' },
  unpaid: { label: 'Unpaid', badge: 'err' },
  canceled: { label: 'Cancelled', badge: 'completed' },
});

// Admin / portal action guards. Each takes the contract (status must already be
// derived) and returns true when the action is allowed right now.
const st = (c) => (c && c.status) || deriveContractStatus(c || {});
const ACTION_GUARDS = Object.freeze({
  // Draft-only edits of purchasers / property / signing mode.
  edit: (c) => st(c) === 'draft',
  delete: (c) => st(c) === 'draft',
  send: (c) => st(c) === 'draft' && c.signingMode !== 'paper',
  // Paper upload of an already-signed agreement. Draft only: a live DocuSign
  // envelope must be voided first so two signed copies can't exist.
  manual_signed: (c) => st(c) === 'draft',
  resend: (c) => st(c) === 'sent' && c.signingMode === 'remote',
  void: (c) => st(c) === 'sent',
  refresh: (c) => Boolean(c && c.envelope && c.envelope.id),
  signing_view: (c) => st(c) === 'sent' && c.signingMode === 'in_person',
  // A dead contract (declined, voided, or cancelled: the homeowner wants to
  // restart, or the house changed hands) is replaced by a fresh draft.
  regenerate: (c) => ['declined', 'voided', 'canceled'].includes(st(c)),
  set_package: (c) => c && c.needsAttention === 'package_missing',
  // Fix or add a purchaser's email / phone after signing (paper contracts can
  // be recorded without one; typos happen). Re-invites the portal account.
  update_contact: (c) => ['awaiting_payment', 'active', 'past_due', 'unpaid'].includes(st(c)),
  resend_invite: (c) => ['awaiting_payment', 'active', 'past_due', 'unpaid'].includes(st(c)) && !c.needsAttention,
  payment_link: (c) => ['awaiting_payment', 'active', 'past_due', 'unpaid'].includes(st(c)) && !c.needsAttention,
  checkout: (c) =>
    st(c) === 'awaiting_payment' &&
    !c.needsAttention &&
    !(c.billing && c.billing.subscriptionId && LIVE_BILLING_STATUSES.includes(c.billing.status)),
  billing_portal: (c) => Boolean(c && c.billing && c.billing.customerId),
  send_reminder: (c) => ['active', 'past_due'].includes(st(c)),
  // awaiting_payment too: a signed contract whose homeowner never sets up
  // payment must be closable (billing.cancelWithoutSubscription).
  cancel: (c) => ['awaiting_payment', 'active', 'past_due', 'unpaid'].includes(st(c)),
  sync_stripe: (c) => Boolean(c && c.billing && c.billing.customerId),
});

function canPerform(action, contract) {
  const guard = ACTION_GUARDS[action];
  if (!guard) throw new Error(`Unknown contract action "${action}"`);
  return Boolean(guard(contract));
}

// Throws err.code='invalid_state' (409) when not allowed. A package-missing
// contract asking for checkout gets the more specific 'package_missing'.
function assertCan(action, contract) {
  if (canPerform(action, contract)) return;
  if ((action === 'checkout' || action === 'payment_link') && contract && contract.needsAttention === 'package_missing') {
    throw contractError('package_missing', 'The monitoring package must be set before payment');
  }
  if (action === 'send' && contract && contract.signingMode === 'paper' && st(contract) === 'draft') {
    throw contractError('invalid_state', 'This is a paper contract: upload the signed PDF instead of sending it through DocuSign');
  }
  throw contractError('invalid_state', `Cannot ${action.replace(/_/g, ' ')} a contract that is ${st(contract)}`);
}

// A closed lot can be reopened only while its current contract (if any) hasn't
// gone past draft — or is dead (declined / voided).
function canReopenLot(contractStatus) {
  return !contractStatus || ['draft', 'declined', 'voided'].includes(contractStatus);
}

module.exports = {
  CONTRACT_STATUSES,
  ENVELOPE_STATUSES,
  ENVELOPE_RANK,
  TERMINAL_ENVELOPE_STATUSES,
  BILLING_STATUSES,
  LIVE_BILLING_STATUSES,
  CONTRACT_STATUS_META,
  ACTION_GUARDS,
  envelopeRank,
  canAdvanceEnvelope,
  envelopeStatusesBelow,
  mapStripeSubStatus,
  deriveContractStatus,
  canPerform,
  assertCan,
  canReopenLot,
};

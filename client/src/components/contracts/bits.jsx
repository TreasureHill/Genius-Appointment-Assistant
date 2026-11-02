import './contracts.css';

// Small pieces shared by every alarm-monitoring contract screen (lot card,
// Contracts page, contract detail, Settings cards) and the homeowner portal.
// Prices and amounts always come from the API in cents — the client never
// computes tax itself.

export { downloadFile } from '../../download.js';

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

// 2824 → "$28.24". Blank for missing values so tables can print it unguarded.
export function fmtMoney(cents) {
  if (cents == null || cents === '' || !Number.isFinite(Number(cents))) return '';
  return cad.format(Number(cents) / 100);
}

// Mirror of server/src/services/contracts/status.js CONTRACT_STATUS_META.
// `badge` is an existing .badge.* class in styles.css.
export const CONTRACT_STATUS_META = {
  draft: { label: 'Draft', badge: 'pending' },
  sent: { label: 'Awaiting signature', badge: 'contacted' },
  declined: { label: 'Declined', badge: 'opted_out' },
  voided: { label: 'Voided', badge: 'completed' },
  awaiting_payment: { label: 'Awaiting payment setup', badge: 'scheduled' },
  active: { label: 'Active', badge: 'ok' },
  past_due: { label: 'Past due', badge: 'err' },
  unpaid: { label: 'Unpaid', badge: 'err' },
  canceled: { label: 'Cancelled', badge: 'completed' },
};

export const CONTRACT_STATUSES = Object.keys(CONTRACT_STATUS_META);

// DocuSign envelope mirror (contract.envelope.status).
export const ENVELOPE_META = {
  created: { label: 'Created', badge: 'pending' },
  sent: { label: 'Sent', badge: 'contacted' },
  delivered: { label: 'Opened', badge: 'contacted' },
  completed: { label: 'Completed', badge: 'ok' },
  declined: { label: 'Declined', badge: 'opted_out' },
  voided: { label: 'Voided', badge: 'completed' },
};

// Per-signer status (contract.purchasers[].signStatus).
export const SIGNER_META = {
  '': { label: 'Not sent', badge: 'pending' },
  created: { label: 'Waiting', badge: 'pending' },
  sent: { label: 'Email sent', badge: 'contacted' },
  delivered: { label: 'Opened', badge: 'contacted' },
  signed: { label: 'Signed', badge: 'ok' },
  completed: { label: 'Signed', badge: 'ok' },
  declined: { label: 'Declined', badge: 'opted_out' },
  autoresponded: { label: 'Bounced', badge: 'err' },
};

// Stripe subscription mirror (contract.billing.status).
export const BILLING_META = {
  none: { label: 'Not set up', badge: 'pending' },
  checkout_open: { label: 'Checkout started', badge: 'contacted' },
  incomplete: { label: 'Incomplete', badge: 'contacted' },
  active: { label: 'Active', badge: 'ok' },
  past_due: { label: 'Past due', badge: 'err' },
  unpaid: { label: 'Unpaid', badge: 'err' },
  canceled: { label: 'Cancelled', badge: 'completed' },
  incomplete_expired: { label: 'Expired', badge: 'completed' },
  paused: { label: 'Paused', badge: 'contacted' },
};

// ContractPayment.status (Stripe invoice).
export const PAYMENT_META = {
  draft: { label: 'Draft', badge: 'pending' },
  open: { label: 'Open', badge: 'contacted' },
  paid: { label: 'Paid', badge: 'ok' },
  uncollectible: { label: 'Uncollectible', badge: 'err' },
  void: { label: 'Void', badge: 'completed' },
};

export const PACKAGE_LABEL = {
  basic: 'Basic Monitoring',
  smart: 'Smart Monitoring',
};

export const SIGNING_MODE_LABEL = {
  remote: 'Email to sign (DocuSign)',
  in_person: 'Sign now on this device',
  paper: 'Signed on paper (upload)',
};

export const DOCUMENT_KIND_LABEL = {
  agreement_unsigned: 'Agreement (unsigned)',
  agreement_signed: 'Signed agreement',
  certificate: 'Certificate of completion',
  other: 'Other document',
};

function MetaBadge({ meta, value }) {
  const m = meta[value] || { label: value || '—', badge: 'pending' };
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

export function ContractStatusBadge({ status }) {
  return <MetaBadge meta={CONTRACT_STATUS_META} value={status} />;
}

export function EnvelopeBadge({ status }) {
  return <MetaBadge meta={ENVELOPE_META} value={status} />;
}

export function SignerBadge({ status }) {
  return <MetaBadge meta={SIGNER_META} value={status || ''} />;
}

export function BillingBadge({ status }) {
  return <MetaBadge meta={BILLING_META} value={status} />;
}

export function PaymentBadge({ status }) {
  return <MetaBadge meta={PAYMENT_META} value={status} />;
}

// "Smart Monitoring — $32.99 + HST = $37.28/month" from a contract's pricing.
export function packageLine(pkg, pricing) {
  if (!pkg) return 'Package not chosen yet';
  const label = PACKAGE_LABEL[pkg] || pkg;
  if (!pricing || pricing.totalCents == null) return label;
  return `${label} — ${fmtMoney(pricing.unitCents)} + HST = ${fmtMoney(pricing.totalCents)}/month`;
}

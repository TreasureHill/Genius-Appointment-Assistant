// Formatting + small utilities for the admin contract screens (lot card,
// Contracts page, contract detail, send dialog). Kept apart from bits.jsx so
// the shared badge/label module stays small.

// Closing and signed dates are date-only values the server stores at 12:00
// UTC, so they are formatted in UTC: the same calendar day in every zone.
export function fmtDay(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

// A real instant (next charge, subscription start) as "Nov 3, 2026" in the
// schedule timezone.
export function fmtDayIn(d, tz) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleDateString('en-US', { timeZone: tz || undefined, month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

// Date-only value → "YYYY-MM-DD" for an <input type="date">.
export function toDateInput(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// Today in the browser's zone as "YYYY-MM-DD" (the default closing / signed
// date — staff click "Mark closed" on the day of the closing).
export function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

// "45 s" / "12 min" for a refresh throttle's retryAfter (seconds).
export function waitText(sec) {
  const n = Math.max(1, Math.ceil(Number(sec) || 0));
  return n < 60 ? `${n} s` : `${Math.ceil(n / 60)} min`;
}

export const plural = (n, word, pluralWord) => `${Number(n || 0).toLocaleString()} ${n === 1 ? word : pluralWord || `${word}s`}`;

export const ROLE_LABEL = { buyer: 'Buyer', coBuyer: 'Co-buyer', thirdBuyer: 'Third buyer' };

// ContractEvent.actor → who did it, for the history lists.
export const EVENT_ACTOR_LABEL = {
  user: 'Staff',
  homeowner: 'Homeowner',
  docusign: 'DocuSign',
  docusign_poller: 'DocuSign check',
  stripe: 'Stripe',
  stripe_reconciler: 'Stripe sync',
  reminder_worker: 'Reminders',
  system: 'System',
};

// The human sentence for an API error. api.js keeps the short code in
// err.message and the full JSON body in err.data; the routes put a readable
// sentence in data.message.
export function errText(e) {
  if (!e) return 'Something went wrong';
  const m = e.data && e.data.message;
  if (m) return m;
  const code = e.message || '';
  const known = {
    not_configured: 'This integration is not configured yet (see Settings).',
    docusign_consent_required: 'DocuSign needs a one-time consent before it can send.',
    invalid_state: 'That is not possible in the contract’s current state. Reload and try again.',
    contract_exists: 'This lot already has a monitoring contract.',
    contract_in_progress: 'A monitoring contract is in progress on this lot.',
    lot_not_closed: 'Mark the lot closed first.',
    no_signer_email: 'Each purchaser who signs needs a valid email.',
    document_too_large: 'The file is larger than 15 MB.',
    invalid_document: 'That file could not be used.',
    not_implemented: 'This part is not available yet.',
  };
  return known[code] || code || 'Something went wrong';
}

// Copy to the clipboard; resolves false when the browser refuses (no HTTPS,
// permissions) so the caller can show the text for a manual copy instead.
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Open a same-origin URL (cookie auth) in a new tab. The tab is opened
// synchronously by the click and pointed at the URL once `prepare` resolves,
// so popup blockers allow it even when we save first.
export async function openAfter(prepare) {
  const w = window.open('about:blank', '_blank');
  try {
    const url = await prepare();
    if (!url) {
      if (w) w.close();
      return;
    }
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

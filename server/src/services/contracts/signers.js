// DocuSign signer list for a contract — pure (no DB, no network).
//
// Owner: DocuSign track (tests: contractDocusign.test.js).
//
// Rules (plan decision 6 + reviewer corrections):
//  - signers = contract.purchasers with signs !== false and a valid email;
//    `optedOut` (marketing) never stops a buyer signing
//  - dedupe on email + name (case-insensitive) — never on email alone, a
//    couple sharing one inbox both sign
//  - sequential routing: recipientId / routingOrder 1..n in purchaser order,
//    with the primary buyer first; if the primary has no email the first
//    purchaser who has one becomes recipient 1
//  - recipient 1 owns the required `monitoringPackage` radio group
//  - clientUserId only for signingMode 'in_person' ("<contractId>-<n>")
//  - nobody left → throw contractError('no_signer_email')

const { contractError } = require('./errors');

// Anchor strings drawn (white, 6pt) into the agreement PDF and referenced by
// the DocuSign tabs. Single source for agreementPdf.js and docusign.js.
// n = the signer's 1-based position in buildSigners() output.
const ANCHORS = Object.freeze({
  packageBasic: '\\gpkb\\',
  packageSmart: '\\gpks\\',
  signHere: (n) => `\\gsig${n}\\`,
  fullName: (n) => `\\gnam${n}\\`,
  dateSigned: (n) => `\\gdat${n}\\`,
});

const PACKAGE_GROUP = 'monitoringPackage';

// Deliberately loose: DocuSign does its own validation; this only filters
// blanks and obvious typos ("jane@", "n/a") before we build an envelope.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dedupe key: same person = same email AND same name.
function signerKey(p) {
  return `${String((p && p.email) || '').trim().toLowerCase()}|${String((p && p.name) || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()}`;
}

/**
 * @typedef {Object} SignerSpec
 * @property {string} recipientId     '1'..'n'
 * @property {number} routingOrder    1..n (sequential)
 * @property {number} n               1-based anchor number (= routingOrder)
 * @property {string} name
 * @property {string} email           lowercase
 * @property {string} role            buyer | coBuyer | thirdBuyer
 * @property {number} purchaserIndex  index into contract.purchasers
 * @property {string|null} clientUserId  in_person only
 * @property {boolean} ownsPackage    true for recipient 1 only
 * @property {{signHere:string, fullName:string, dateSigned:string}} anchors
 */

/**
 * @param {Array<{role,name,email,phone,signs}>} purchasers
 * @param {{mode?: 'remote'|'in_person', contractId?: string}} opts
 * @returns {SignerSpec[]}
 * @throws err.code 'no_signer_email'
 */
function buildSigners(purchasers, { mode = 'remote', contractId = '' } = {}) {
  const out = [];
  const seen = new Set();
  (purchasers || []).forEach((p, purchaserIndex) => {
    if (!p || p.signs === false) return;
    const email = String(p.email || '').trim().toLowerCase();
    // A purchaser with no (valid) email can't receive or open an envelope.
    // They stay on the agreement as a listed purchaser but don't sign.
    if (!EMAIL_RE.test(email)) return;
    const key = signerKey({ email, name: p.name });
    if (seen.has(key)) return;
    seen.add(key);
    const n = out.length + 1;
    const name = String(p.name || '').trim().replace(/\s+/g, ' ');
    out.push({
      recipientId: String(n),
      routingOrder: n,
      n,
      // DocuSign requires a name; fall back to the address rather than fail.
      name: name || email,
      email,
      role: p.role || (n === 1 ? 'buyer' : 'coBuyer'),
      purchaserIndex,
      // Embedded signers get no DocuSign email; the id ties the tablet
      // session to this recipient. Stable per contract + position so a
      // recipient view can be re-requested at any time.
      clientUserId: mode === 'in_person' ? `${contractId}-${n}` : null,
      ownsPackage: n === 1,
      anchors: { signHere: ANCHORS.signHere(n), fullName: ANCHORS.fullName(n), dateSigned: ANCHORS.dateSigned(n) },
    });
  });
  if (!out.length) {
    throw contractError('no_signer_email', 'At least one purchaser who signs needs a valid email address');
  }
  return out;
}

module.exports = { ANCHORS, PACKAGE_GROUP, signerKey, buildSigners };

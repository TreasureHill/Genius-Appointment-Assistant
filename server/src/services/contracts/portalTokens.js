const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { contractError } = require('./errors');
const { isValidPackage } = require('./pricing');

// Homeowner portal accounts and their single-use links.
//  - tokens: randomBytes(32) base64url; only sha256 hex is stored
//  - invite (set password) lasts 7 days, reset 1 hour; issuing a new one
//    replaces the old
//  - consuming is one findOneAndUpdate({tokenHash, tokenPurpose,
//    tokenExpiresAt > now}) that sets the password, clears the token and
//    bumps tokenVersion (logs out every other session)
//  - links carry the token in the URL FRAGMENT (#t=…), never a query string,
//    so it never reaches server or proxy logs (emails.setPasswordUrl)
//
// Owner: emails/portal-accounts track (tests: contractPortalTokens.test.js). The pure
// helpers were shipped by the foundation.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;
const BCRYPT_COST = 12;

/** @returns {string} 43-char base64url */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** @returns {string} sha256 hex */
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

/** "jane.doe@example.com" → "j***@example.com" (token-info, logs). */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 1)}***@${domain}`;
}

// Longest password we accept. bcrypt only looks at the first 72 bytes; the
// cap just stops someone posting megabytes into a deliberately slow hash.
const MAX_PASSWORD_LENGTH = 200;
const PURPOSES = ['invite', 'reset'];

// Models are required lazily (and can be swapped by tests through _deps) so the
// pure helpers load without mongoose models being registered.
const deps = {
  PortalUser: () => require('../../models/PortalUser'),
  AlarmContract: () => require('../../models/AlarmContract'),
  ContractDocument: () => require('../../models/ContractDocument'),
  emails: () => require('./emails'),
  logContractEvent: (ev) => require('./eventLogger').logContractEvent(ev),
  now: () => new Date(),
};

const ttlFor = (purpose) => (purpose === 'reset' ? RESET_TTL_MS : INVITE_TTL_MS);
const normEmail = (e) => String(e || '').trim().toLowerCase();
const idStr = (v) => String((v && v._id) || v || '');

/**
 * Password rules (pure): at least MIN_PASSWORD_LENGTH characters, at most
 * MAX_PASSWORD_LENGTH. Throws weak_password / validation_failed.
 */
function assertPasswordOk(password) {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw contractError('weak_password', `Use at least ${MIN_PASSWORD_LENGTH} characters`, { field: 'password' });
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    throw contractError('validation_failed', `Use at most ${MAX_PASSWORD_LENGTH} characters`, { field: 'password' });
  }
  return pw;
}

/**
 * Store a fresh token on the user (replacing any previous one) and return the
 * RAW token for the email link.
 * @param {object} user PortalUser doc
 * @param {'invite'|'reset'} purpose
 * @returns {Promise<string>}
 */
async function issueToken(user, purpose) {
  if (!PURPOSES.includes(purpose)) throw contractError('validation_failed', `Unknown token purpose ${purpose}`);
  if (!user || !user._id) throw contractError('not_found', 'Portal user not found');
  const raw = generateToken();
  const fields = {
    tokenHash: hashToken(raw),
    tokenPurpose: purpose,
    tokenExpiresAt: new Date(deps.now().getTime() + ttlFor(purpose)),
  };
  await deps.PortalUser().updateOne({ _id: user._id }, { $set: fields });
  Object.assign(user, fields); // keep the caller's copy in step
  return raw;
}

// The live-token filter. `purpose` may be one purpose, a list, or omitted.
function tokenFilter(raw, purpose, now) {
  const purposes = purpose == null ? PURPOSES : (Array.isArray(purpose) ? purpose : [purpose]).filter((p) => PURPOSES.includes(p));
  return {
    tokenHash: hashToken(raw),
    tokenPurpose: { $in: purposes },
    tokenExpiresAt: { $gt: now },
    disabled: { $ne: true },
  };
}

const plausibleToken = (raw) => typeof raw === 'string' && raw.length >= 20 && raw.length <= 200;

/**
 * Look a token up without consuming it (POST /api/portal/auth/token-info).
 * @param {string} raw
 * @param {'invite'|'reset'} [purpose] any when omitted
 * @returns {Promise<{valid: boolean, purpose?: 'invite'|'reset', emailMasked?: string, user?: object}>}
 */
async function peekToken(raw, purpose) {
  if (!plausibleToken(raw)) return { valid: false };
  const user = await deps.PortalUser().findOne(tokenFilter(raw, purpose, deps.now()));
  if (!user) return { valid: false };
  return { valid: true, purpose: user.tokenPurpose, emailMasked: maskEmail(user.email), user };
}

/**
 * Consume a token and set the password (atomic, single use).
 * @param {string} raw
 * @param {'invite'|'reset'|Array<'invite'|'reset'>} purpose
 * @param {string} password  ≥ MIN_PASSWORD_LENGTH
 * @returns {Promise<object>} the updated PortalUser doc (tokenVersion bumped)
 * @throws weak_password | invalid_token (unknown, expired, used, wrong purpose)
 */
async function consumeToken(raw, purpose, password) {
  const pw = assertPasswordOk(password);
  if (!plausibleToken(raw)) throw contractError('invalid_token', 'This link is invalid or has expired');
  // Hash first: the single findOneAndUpdate below is what makes the token
  // single-use, so nothing slow may sit between "token valid" and "consumed".
  const passwordHash = await hashPassword(pw);
  const now = deps.now();
  const user = await deps.PortalUser().findOneAndUpdate(
    tokenFilter(raw, purpose, now),
    {
      $set: {
        passwordHash,
        passwordSetAt: now,
        tokenHash: null,
        tokenPurpose: null,
        tokenExpiresAt: null,
        // Proving control of the inbox clears a lockout too.
        failedLogins: 0,
        lockedUntil: null,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true }
  );
  if (!user) throw contractError('invalid_token', 'This link is invalid or has expired');
  return user;
}

/** bcryptjs hash (cost 12). @returns {Promise<string>} */
async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_COST);
}

/** @returns {Promise<boolean>} false for users with no password yet */
async function verifyPassword(user, password) {
  if (!user || !user.passwordHash || typeof password !== 'string' || !password) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await bcrypt.compare(password, user.passwordHash);
  } catch {
    return false;
  }
}

/**
 * Unique signer emails of a contract with the name(s) that go with each
 * (pure). Couples sharing an inbox share one account: "Jane Doe and John Doe".
 * Purchasers marked signs:false are left out unless nobody signs.
 * @returns {Array<{email: string, name: string}>}
 */
function portalAccountsFor(contract) {
  const withEmail = ((contract && contract.purchasers) || []).filter((p) => p && normEmail(p.email));
  const signers = withEmail.filter((p) => p.signs !== false);
  const byEmail = new Map();
  for (const p of signers.length ? signers : withEmail) {
    const email = normEmail(p.email);
    if (!byEmail.has(email)) byEmail.set(email, []);
    const name = String(p.name || '').trim();
    if (name && !byEmail.get(email).includes(name)) byEmail.get(email).push(name);
  }
  return [...byEmail].map(([email, names]) => ({ email, name: names.join(' and ') }));
}

/**
 * One PortalUser per unique signer email on the contract (upsert by email,
 * $addToSet the contract). Purchasers with no email are skipped.
 * @param {object} contract
 * @returns {Promise<object[]>} PortalUser docs
 */
async function upsertPortalUsersForContract(contract) {
  const PortalUser = deps.PortalUser();
  const users = [];
  for (const { email, name } of portalAccountsFor(contract)) {
    const op = () =>
      PortalUser.findOneAndUpdate(
        { email },
        { $setOnInsert: { email, name }, $addToSet: { contracts: contract._id } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    let u;
    try {
      u = await op();
    } catch (err) {
      // Two completions racing on a brand-new email: one upsert wins the
      // unique index, the other retries as a plain update.
      if (err && err.code === 11000) u = await op();
      else throw err;
    }
    if (u && !u.name && name) {
      await PortalUser.updateOne({ _id: u._id, name: '' }, { $set: { name } });
      u.name = name;
    }
    users.push(u);
  }
  return users;
}

// The signed agreement as an email attachment (null when not stored yet).
async function signedAttachment(c) {
  const ContractDocument = deps.ContractDocument();
  const q = c.documents && c.documents.signed ? { _id: c.documents.signed } : { contract: c._id, kind: 'agreement_signed' };
  const doc = await ContractDocument.findOne(q).sort({ createdAt: -1 }).lean();
  if (!doc || !doc.data) return null;
  const content = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
  return {
    filename: `${c.number || 'agreement'}-signed.pdf`,
    content,
    contentType: doc.contentType || 'application/pdf',
  };
}

/**
 * Welcome email(s) after signing. Claims contract.portal.invitedAt (unless
 * force), upserts portal users, and sends one 'welcome' email PER USER (each
 * link is personal): users without a password get an invite token link
 * (emails.setPasswordUrl), users with one get a log-in link. The signed
 * agreement PDF (ContractDocument agreement_signed) is attached. Bumps
 * portal.inviteCount. Never throws for email failures (reported per user).
 * @param {object} contract
 * @param {{actor?: string, user?: string, force?: boolean}} [opts]
 *        force:true = admin "Resend invite" (ignores the invitedAt claim, new tokens)
 * @returns {Promise<{sent: number, skipped?: 'already_invited'|'package_missing', results: Array<{email: string, ok: boolean, error?: string}>}>}
 */
async function inviteContractUsers(contract, { actor = 'system', user = '', force = false } = {}) {
  const AlarmContract = deps.AlarmContract();
  const c = await AlarmContract.findById(idStr(contract)).lean();
  if (!c) throw contractError('not_found', 'Contract not found');
  if (!isValidPackage(c.package) || c.needsAttention) return { sent: 0, skipped: 'package_missing', results: [] };

  const now = deps.now();
  if (force) {
    await AlarmContract.updateOne({ _id: c._id }, { $set: { 'portal.invitedAt': now } });
  } else {
    // The claim: whoever flips invitedAt from null sends; replays and the
    // poller's completion retries see it set and stop here.
    const claimed = await AlarmContract.findOneAndUpdate(
      { _id: c._id, 'portal.invitedAt': null },
      { $set: { 'portal.invitedAt': now } },
      { new: true, projection: { _id: 1 } }
    ).lean();
    if (!claimed) return { sent: 0, skipped: 'already_invited', results: [] };
  }

  const results = [];
  try {
    const users = await upsertPortalUsersForContract(c);
    let attachment = null;
    try {
      attachment = await signedAttachment(c);
    } catch (err) {
      console.warn('[contracts] signed agreement not attached', String(c._id), err.message);
    }
    const emails = deps.emails();
    for (const u of users) {
      if (!u || u.disabled) {
        if (u) results.push({ email: u.email, ok: false, error: 'disabled' });
        continue;
      }
      try {
        const hasPassword = Boolean(u.passwordHash);
        const actionUrl = hasPassword
          ? emails.portalUrl(c.status === 'awaiting_payment' ? `/pay?contract=${encodeURIComponent(String(c._id))}` : '/')
          : emails.setPasswordUrl(await issueToken(u, 'invite'), 'invite');
        const r = await emails.sendContractEmail({
          contract: c,
          kind: 'welcome',
          to: u.email,
          data: { actionUrl, hasPassword, recipientName: u.name || '' },
          attachments: attachment ? [attachment] : undefined,
          actor,
          actorName: user,
        });
        results.push(r.ok ? { email: u.email, ok: true } : { email: u.email, ok: false, error: r.error || r.skipped || 'send_failed' });
      } catch (err) {
        results.push({ email: u.email, ok: false, error: err.message });
      }
    }
  } catch (err) {
    // Couldn't even get as far as sending: release the claim so a retry or
    // the admin button can try again, then report.
    if (!force) await AlarmContract.updateOne({ _id: c._id, 'portal.invitedAt': now }, { $set: { 'portal.invitedAt': null } });
    throw err;
  }

  const sent = results.filter((r) => r.ok).length;
  const priorFailures = (c.portal && c.portal.inviteFailures) || 0;
  if (sent > 0) {
    await AlarmContract.updateOne(
      { _id: c._id },
      { $inc: { 'portal.inviteCount': 1 }, $set: { 'portal.inviteFailures': 0, 'portal.lastInviteFailureAt': null } }
    );
  } else if (!force) {
    // Nothing went out (no email on file, SMTP down …): give the claim back
    // so the contract shows "not invited" and Resend invite / a retry works.
    // The failure count drives the contract tail worker's backoff.
    await AlarmContract.updateOne({ _id: c._id, 'portal.invitedAt': now }, { $set: { 'portal.invitedAt': null } });
    await AlarmContract.updateOne(
      { _id: c._id },
      { $inc: { 'portal.inviteFailures': 1 }, $set: { 'portal.lastInviteFailureAt': now } }
    );
  }
  // One history line per outage, not one per automatic retry.
  if (!sent && (force || priorFailures === 0)) {
    await deps.logContractEvent({
      contract: c,
      type: 'alert',
      actor,
      actorName: user,
      message: results.length ? 'Welcome email could not be sent' : 'No purchaser email on file for the portal invite',
      meta: { results: results.map((r) => ({ email: r.email, ok: r.ok, error: r.error || '' })) },
    });
  }
  return { sent, results };
}

module.exports = {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  MIN_PASSWORD_LENGTH,
  BCRYPT_COST,
  MAX_PASSWORD_LENGTH,
  generateToken,
  hashToken,
  maskEmail,
  issueToken,
  peekToken,
  consumeToken,
  hashPassword,
  verifyPassword,
  upsertPortalUsersForContract,
  inviteContractUsers,
  // helpers (pure) + test seam
  assertPasswordOk,
  portalAccountsFor,
  _deps: deps,
};

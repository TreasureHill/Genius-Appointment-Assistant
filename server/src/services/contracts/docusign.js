const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const { isValidPackage } = require('./pricing');
const { ANCHORS, PACKAGE_GROUP } = require('./signers');
const { contractError, CONTRACT_ERROR_HTTP } = require('./errors');

// DocuSign eSignature REST v2.1 client — axios + jsonwebtoken (RS256 JWT
// grant), no SDK.
//
// Owner: DocuSign track (tests: contractDocusign.test.js). The three pure
// helpers at the bottom (verifyConnectHmac, normaliseConnectPayload,
// extractPackageChoice) were shipped by the foundation because the webhook
// route depends on them.
//
// API-calling functions all:
//  - throw contractError('not_configured') when !env.docusign.configured
//  - map {"error":"consent_required"} to contractError('docusign_consent_required',
//    msg, { consentUrl: env.docusign.consentUrl })
//  - map other auth failures to 'docusign_auth_failed', envelope create
//    failures to 'envelope_failed' (ANCHOR_NOT_FOUND → 'anchor_missing')
//  - never log the Authorization header, the private key or request bodies

// Tab placement relative to each white anchor (pixels). The anchors are drawn
// just above the left end of each signature line / in the radio gutter of
// each package line (agreementPdf.js); tune once in the demo account if a tab
// lands off its line.
const TAB_OFFSETS = Object.freeze({
  signHere: { x: '0', y: '-14' },
  fullName: { x: '0', y: '0' },
  dateSigned: { x: '0', y: '0' },
  radio: { x: '0', y: '-2' },
});

const CONNECT_EVENTS = Object.freeze([
  'envelope-sent',
  'envelope-delivered',
  'envelope-completed',
  'envelope-declined',
  'envelope-voided',
  'recipient-completed',
  'recipient-declined',
]);

const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const STATUS_BATCH = 100;

// HTTP transport. A module variable (not axios directly) so the tests can
// swap in a fake and run with no network.
let http = (config) => axios(config);
function __setHttp(fn) {
  http = fn || ((config) => axios(config));
  resetCache();
}

let tokenCache = null; // { token, expiresAt }
let tokenInflight = null;
let accountCache = null; // { accountId, accountName, baseUri, basePath }

function resetCache() {
  tokenCache = null;
  tokenInflight = null;
  accountCache = null;
}

// Our own errors pass straight through the wrappers. (axios errors also carry
// .code / .status, so check the vocabulary, not just the fields.)
function isContractError(err) {
  return Boolean(err && !err.isAxiosError && typeof err.code === 'string' && CONTRACT_ERROR_HTTP[err.code]);
}

function requireConfigured() {
  if (!env.docusign.configured) {
    throw contractError('not_configured', 'DocuSign is not configured (DOCUSIGN_* in .env)');
  }
}

// One readable line from an axios error, without headers or request bodies.
function describeError(err) {
  const d = err && err.response && err.response.data;
  if (d && typeof d === 'object' && !Buffer.isBuffer(d)) {
    if (d.errorCode || d.message) return [d.errorCode, d.message].filter(Boolean).join(': ');
    if (d.error) return [d.error, d.error_description].filter(Boolean).join(': ');
  }
  if (err && err.response) return `HTTP ${err.response.status}`;
  return (err && err.message) || 'Request failed';
}

// arraybuffer responses carry their JSON error body as bytes.
function parseErrorBody(err) {
  const r = err && err.response;
  if (r && (Buffer.isBuffer(r.data) || r.data instanceof ArrayBuffer)) {
    try {
      r.data = JSON.parse(Buffer.from(r.data).toString('utf8'));
    } catch {
      /* leave it */
    }
  }
}

function consentError() {
  return contractError(
    'docusign_consent_required',
    'DocuSign consent is required: an admin must grant consent for this integration once',
    { consentUrl: env.docusign.consentUrl }
  );
}

/** Connect webhook URL for eventNotification. */
function connectWebhookUrl() {
  return `${env.appUrl}/api/webhooks/docusign`;
}

async function fetchToken() {
  const d = env.docusign;
  let assertion;
  try {
    assertion = jwt.sign({ iss: d.integrationKey, sub: d.userId, aud: d.authHost, scope: 'signature impersonation' }, d.privateKey, {
      algorithm: 'RS256',
      expiresIn: 3600,
    });
  } catch {
    // Bad PEM. Don't echo the key or the library's message (it can quote it).
    throw contractError('docusign_auth_failed', 'DocuSign private key could not be used to sign the JWT (check DOCUSIGN_PRIVATE_KEY)');
  }
  let res;
  try {
    res = await http({
      method: 'post',
      url: `https://${d.authHost}/oauth/token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    const data = err && err.response && err.response.data;
    if (data && data.error === 'consent_required') throw consentError();
    throw contractError('docusign_auth_failed', `DocuSign authentication failed (${describeError(err)})`);
  }
  const body = (res && res.data) || {};
  if (!body.access_token) throw contractError('docusign_auth_failed', 'DocuSign returned no access token');
  const ttlMs = (Number(body.expires_in) || 3600) * 1000;
  tokenCache = { token: body.access_token, expiresAt: Date.now() + ttlMs };
  return body.access_token;
}

/**
 * Cached access token (refreshed ~5 min before expiry). Concurrent callers
 * share one in-flight grant.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  requireConfigured();
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return tokenCache.token;
  if (!tokenInflight) {
    tokenInflight = fetchToken().finally(() => {
      tokenInflight = null;
    });
  }
  return tokenInflight;
}

/**
 * Account + base URI from /oauth/userinfo (cached). Honours
 * DOCUSIGN_ACCOUNT_ID; fails if it isn't one of the user's accounts.
 * @returns {Promise<{accountId: string, accountName: string, baseUri: string, basePath: string}>}
 *          basePath = `${baseUri}/restapi/v2.1/accounts/${accountId}`
 */
async function getAccount() {
  if (accountCache) return accountCache;
  const token = await getAccessToken();
  let res;
  try {
    res = await http({
      method: 'get',
      url: `https://${env.docusign.authHost}/oauth/userinfo`,
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw contractError('docusign_auth_failed', `DocuSign userinfo failed (${describeError(err)})`);
  }
  const accounts = ((res && res.data && res.data.accounts) || []).filter(Boolean);
  const wanted = env.docusign.accountId;
  const acct = wanted ? accounts.find((a) => a.account_id === wanted) : accounts.find((a) => a.is_default === true || a.is_default === 'true') || accounts[0];
  if (!acct) {
    throw contractError(
      'docusign_auth_failed',
      wanted ? 'DOCUSIGN_ACCOUNT_ID is not one of the DocuSign user\'s accounts' : 'The DocuSign user has no accounts'
    );
  }
  // base_uri is regional (demo.docusign.net, na3…, ca.docusign.net) — never hard-coded.
  const baseUri = String(acct.base_uri || '').replace(/\/+$/, '');
  accountCache = {
    accountId: acct.account_id,
    accountName: acct.account_name || '',
    baseUri,
    basePath: `${baseUri}/restapi/v2.1/accounts/${acct.account_id}`,
  };
  return accountCache;
}

// Authenticated call against the account's REST base. One retry with a fresh
// token on 401 (token revoked / clock skew).
async function api(method, path, { data, params, responseType, retried = false } = {}) {
  const acct = await getAccount();
  const token = await getAccessToken();
  try {
    const res = await http({
      method,
      url: `${acct.basePath}${path}`,
      headers: { Authorization: `Bearer ${token}`, Accept: responseType === 'arraybuffer' ? 'application/pdf' : 'application/json' },
      data,
      params,
      responseType,
      timeout: REQUEST_TIMEOUT_MS,
      maxBodyLength: 40 * 1024 * 1024,
      maxContentLength: 40 * 1024 * 1024,
    });
    return res.data;
  } catch (err) {
    parseErrorBody(err);
    if (err && err.response && err.response.status === 401 && !retried) {
      tokenCache = null;
      return api(method, path, { data, params, responseType, retried: true });
    }
    throw err;
  }
}

// Generic mapping for read / update calls.
function wrapApiError(err, what) {
  if (isContractError(err)) return err;
  const e = contractError('envelope_failed', `DocuSign ${what} failed (${describeError(err)})`);
  e.httpStatus = err && err.response ? err.response.status : undefined;
  e.docusignErrorCode = err && err.response && err.response.data && err.response.data.errorCode;
  return e;
}

/**
 * Health check for Settings → DocuSign → Test. Never throws.
 * @returns {Promise<{ok: boolean, message: string, consentUrl?: string, accountId?: string, baseUri?: string}>}
 */
async function verifyDocusign() {
  if (!env.docusign.configured) return { ok: false, message: 'DocuSign not configured' };
  try {
    // Always a fresh grant: the point of the test is to prove auth works now.
    resetCache();
    const acct = await getAccount();
    const parts = [`Connected to ${acct.accountName || acct.accountId} (${env.docusign.env})`];
    if (!env.docusign.connectEnabled) parts.push('Connect webhook off: status updates come from the 20-minute poller');
    return { ok: true, message: parts.join('. '), accountId: acct.accountId, baseUri: acct.baseUri };
  } catch (err) {
    const out = { ok: false, message: (err && err.message) || 'DocuSign check failed' };
    if (err && err.code === 'docusign_consent_required') out.consentUrl = err.consentUrl;
    return out;
  }
}

/**
 * Per-envelope Connect config (pure). JSON SIM, HMAC, ack required.
 * includeData lives INSIDE eventData; no legacy envelopeEvents /
 * recipientEvents arrays with SIM.
 * @param {string} [url] default connectWebhookUrl()
 * @returns {object}
 */
function buildEventNotification(url) {
  return {
    url: url || connectWebhookUrl(),
    requireAcknowledgment: 'true',
    includeHMAC: 'true',
    loggingEnabled: 'true',
    deliveryMode: 'SIM',
    events: CONNECT_EVENTS.slice(),
    eventData: { version: 'restv2.1', format: 'json', includeData: ['recipients', 'tabs', 'custom_fields'] },
  };
}

function anchorTab(anchorString, offsets) {
  return {
    anchorString,
    anchorUnits: 'pixels',
    anchorXOffset: offsets.x,
    anchorYOffset: offsets.y,
    // A layout bug must fail the send loudly, not produce an envelope with
    // no signature field.
    anchorIgnoreIfNotPresent: 'false',
    anchorMatchWholeWord: 'true',
  };
}

// The required package radio group, owned by recipient 1 only (sequential
// routing: later signers see the choice read-only). `required` goes on each
// radio — the group has no such property — and nothing is preselected.
function packageRadioGroup(recipientId) {
  return {
    groupName: PACKAGE_GROUP,
    documentId: '1',
    recipientId,
    shared: 'false',
    radios: [
      { ...anchorTab(ANCHORS.packageBasic, TAB_OFFSETS.radio), value: 'basic', required: 'true' },
      { ...anchorTab(ANCHORS.packageSmart, TAB_OFFSETS.radio), value: 'smart', required: 'true' },
    ],
  };
}

function signerTabs(s) {
  const tabs = {
    signHereTabs: [{ ...anchorTab(s.anchors.signHere, TAB_OFFSETS.signHere), documentId: '1', recipientId: s.recipientId }],
    fullNameTabs: [{ ...anchorTab(s.anchors.fullName, TAB_OFFSETS.fullName), documentId: '1', recipientId: s.recipientId }],
    dateSignedTabs: [{ ...anchorTab(s.anchors.dateSigned, TAB_OFFSETS.dateSigned), documentId: '1', recipientId: s.recipientId }],
  };
  if (s.ownsPackage) tabs.radioGroupTabs = [packageRadioGroup(s.recipientId)];
  return tabs;
}

function emailSubjectFor(contract) {
  const p = (contract && contract.property) || {};
  const where = [p.lotNumber ? `Lot ${p.lotNumber}` : '', p.projectName || ''].filter(Boolean).join(', ');
  const subject = `Genius Alarm Monitoring Agreement${where ? ` – ${where}` : ''}`;
  return subject.length > 100 ? `${subject.slice(0, 99)}…` : subject;
}

/**
 * Envelope create body (pure). Includes status:'sent', the PDF as document 1,
 * signers with anchor tabs (radio group on the signer with ownsPackage),
 * carbonCopies from ccEmail, textCustomFields contractId, emailSubject
 * (≤100 chars) and — only when env.docusign.connectEnabled —
 * eventNotification.
 * @param {{contract: object, pdf: Buffer, signers: import('./signers').SignerSpec[], ccEmail?: string}} a
 * @returns {object}
 */
function buildEnvelopeDefinition({ contract, pdf, signers, ccEmail }) {
  const list = signers || [];
  const def = {
    emailSubject: emailSubjectFor(contract),
    emailBlurb:
      'Please review your Genius alarm monitoring agreement, choose your monitoring package and sign. Questions? Reply to this email.',
    status: 'sent',
    documents: [
      {
        documentBase64: Buffer.from(pdf || []).toString('base64'),
        name: `Alarm Monitoring Agreement${contract && contract.number ? ` ${contract.number}` : ''}`,
        fileExtension: 'pdf',
        documentId: '1',
      },
    ],
    recipients: {
      signers: list.map((s) => {
        const r = {
          email: s.email,
          name: s.name,
          recipientId: String(s.recipientId),
          routingOrder: String(s.routingOrder),
          tabs: signerTabs({ ...s, recipientId: String(s.recipientId) }),
        };
        if (s.clientUserId) r.clientUserId = s.clientUserId;
        return r;
      }),
      carbonCopies: [],
    },
    customFields: {
      textCustomFields: [
        { name: 'contractId', value: String((contract && contract._id) || ''), show: 'false', required: 'false' },
        { name: 'contractNumber', value: String((contract && contract.number) || ''), show: 'false', required: 'false' },
      ],
    },
  };
  const cc = String(ccEmail || '').trim().toLowerCase();
  if (cc) {
    // Last in the routing so the copy is the completed agreement. A fixed
    // high recipientId can't collide with the 1..n signers.
    def.recipients.carbonCopies.push({
      email: cc,
      name: 'Genius Contracts',
      recipientId: '100',
      routingOrder: String(list.length + 1),
    });
  }
  if (env.docusign.connectEnabled) def.eventNotification = buildEventNotification();
  return def;
}

/**
 * @param {{contract: object, pdf: Buffer, signers: import('./signers').SignerSpec[], ccEmail?: string}} a
 * @returns {Promise<{envelopeId: string, status: string, statusDateTime: string}>}
 */
async function createEnvelope({ contract, pdf, signers, ccEmail }) {
  requireConfigured();
  const body = buildEnvelopeDefinition({ contract, pdf, signers, ccEmail });
  let data;
  try {
    data = await api('post', '/envelopes', { data: body });
  } catch (err) {
    if (isContractError(err)) throw err;
    const code = String((err && err.response && err.response.data && err.response.data.errorCode) || '');
    if (/ANCHOR/i.test(code)) {
      throw contractError('anchor_missing', `The agreement PDF is missing a DocuSign anchor (${describeError(err)})`);
    }
    // No answer (timeout, dropped connection) or a 5xx: DocuSign may well
    // have created and emailed the envelope anyway. The caller looks it up
    // (findSentEnvelopesForContract) before treating the send as failed.
    const status = err && err.response ? err.response.status : 0;
    throw contractError('envelope_failed', `DocuSign could not create the envelope (${describeError(err)})`, {
      ambiguous: !status || status >= 500,
    });
  }
  if (!data || !data.envelopeId) throw contractError('envelope_failed', 'DocuSign returned no envelope id');
  return { envelopeId: data.envelopeId, status: String(data.status || 'sent').toLowerCase(), statusDateTime: data.statusDateTime || '' };
}

const enc = (id) => encodeURIComponent(String(id || ''));

/** @returns {Promise<object>} raw GET /envelopes/{id} (status, sentDateTime, completedDateTime, voidedReason…) */
async function getEnvelope(envelopeId) {
  requireConfigured();
  try {
    return await api('get', `/envelopes/${enc(envelopeId)}`);
  } catch (err) {
    throw wrapApiError(err, 'envelope read');
  }
}

/** @returns {Promise<{signers: object[], carbonCopies: object[]}>} raw GET /recipients?include_tabs=true */
async function getRecipientsWithTabs(envelopeId) {
  requireConfigured();
  try {
    const d = (await api('get', `/envelopes/${enc(envelopeId)}/recipients`, { params: { include_tabs: 'true' } })) || {};
    return { ...d, signers: d.signers || [], carbonCopies: d.carbonCopies || [] };
  } catch (err) {
    throw wrapApiError(err, 'recipients read');
  }
}

/** @returns {Promise<{formData: object[], recipientFormData: object[]}>} raw GET /form_data */
async function getFormData(envelopeId) {
  requireConfigured();
  try {
    const d = (await api('get', `/envelopes/${enc(envelopeId)}/form_data`)) || {};
    return { ...d, formData: d.formData || [], recipientFormData: d.recipientFormData || [] };
  } catch (err) {
    throw wrapApiError(err, 'form data read');
  }
}

/**
 * Batched status poll (one call per ≤100 ids; DocuSign forbids polling one
 * envelope more than every 15 min).
 * @param {{envelopeIds: string[], fromDate: Date}} a
 * @returns {Promise<Array<{envelopeId: string, status: string, statusChangedDateTime: string}>>}
 */
async function listStatusChanges({ envelopeIds, fromDate }) {
  requireConfigured();
  const ids = [...new Set((envelopeIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const from = fromDate ? new Date(fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const out = [];
  for (let i = 0; i < ids.length; i += STATUS_BATCH) {
    const chunk = ids.slice(i, i + STATUS_BATCH);
    let d;
    try {
      d = await api('get', '/envelopes', { params: { envelope_ids: chunk.join(','), from_date: from.toISOString() } });
    } catch (err) {
      throw wrapApiError(err, 'status poll');
    }
    for (const e of (d && d.envelopes) || []) {
      out.push({
        envelopeId: e.envelopeId,
        status: String(e.status || '').toLowerCase(),
        statusChangedDateTime: e.statusChangedDateTime || '',
      });
    }
  }
  return out;
}

/**
 * Envelopes out for signature for one contract, found by the contractId
 * custom field every envelope carries (buildEnvelopeDefinition). Used after a
 * createEnvelope that timed out, so an envelope DocuSign did send is adopted
 * instead of orphaned.
 * @param {{contractId: string, fromDate: Date}} a
 * @returns {Promise<Array<{envelopeId: string, status: string, statusDateTime: string}>>}
 */
async function findSentEnvelopesForContract({ contractId, fromDate }) {
  requireConfigured();
  let d;
  try {
    d = await api('get', '/envelopes', {
      params: {
        from_date: new Date(fromDate).toISOString(),
        status: 'sent,delivered',
        custom_field: `contractId=${String(contractId)}`,
      },
    });
  } catch (err) {
    throw wrapApiError(err, 'envelope lookup');
  }
  return ((d && d.envelopes) || [])
    .map((e) => ({
      envelopeId: e.envelopeId,
      status: String(e.status || '').toLowerCase(),
      statusDateTime: e.sentDateTime || e.statusChangedDateTime || '',
    }))
    .filter((e) => e.envelopeId && (e.status === 'sent' || e.status === 'delivered'));
}

async function download(envelopeId, docPath, params, what) {
  requireConfigured();
  try {
    const d = await api('get', `/envelopes/${enc(envelopeId)}/documents/${docPath}`, { params, responseType: 'arraybuffer' });
    return Buffer.from(d);
  } catch (err) {
    throw wrapApiError(err, what);
  }
}

/** Signed document(s) WITHOUT the certificate (?certificate=false). @returns {Promise<Buffer>} */
async function downloadCombined(envelopeId) {
  // The account setting may append the certificate to "combined"; we store
  // it separately, so ask for it explicitly off (stable sha256, no dupes).
  return download(envelopeId, 'combined', { certificate: 'false' }, 'signed PDF download');
}

/** Certificate of Completion. @returns {Promise<Buffer>} */
async function downloadCertificate(envelopeId) {
  return download(envelopeId, 'certificate', undefined, 'certificate download');
}

/** PUT status:'voided'. @returns {Promise<void>} */
async function voidEnvelope(envelopeId, reason) {
  requireConfigured();
  try {
    await api('put', `/envelopes/${enc(envelopeId)}`, {
      data: { status: 'voided', voidedReason: String(reason || 'Voided by Genius').slice(0, 200) },
    });
  } catch (err) {
    throw wrapApiError(err, 'void');
  }
}

/**
 * Re-send the signing emails (PUT recipients?resend_envelope=true) to the
 * signers who haven't finished. @returns {Promise<void>}
 */
async function resendEnvelope(envelopeId) {
  requireConfigured();
  const { signers } = await getRecipientsWithTabs(envelopeId);
  const pending = signers
    .filter((s) => !['completed', 'signed', 'declined'].includes(String(s.status || '').toLowerCase()))
    .map((s) => ({ recipientId: s.recipientId, email: s.email, name: s.name }));
  if (!pending.length) return;
  try {
    await api('put', `/envelopes/${enc(envelopeId)}/recipients`, {
      params: { resend_envelope: 'true' },
      data: { signers: pending },
    });
  } catch (err) {
    throw wrapApiError(err, 'resend');
  }
}

/**
 * Embedded signing URL (in-person mode). Single use, ~5 min.
 * @param {string} envelopeId
 * @param {{recipientId: string, name: string, email: string, clientUserId: string, returnUrl: string}} a
 * @returns {Promise<{url: string}>}
 */
async function createRecipientView(envelopeId, { recipientId, name, email, clientUserId, returnUrl }) {
  requireConfigured();
  let d;
  try {
    d = await api('post', `/envelopes/${enc(envelopeId)}/views/recipient`, {
      data: {
        returnUrl,
        authenticationMethod: 'none',
        email,
        userName: name,
        clientUserId,
        recipientId: String(recipientId),
      },
    });
  } catch (err) {
    if (isContractError(err)) throw err;
    const code = String((err && err.response && err.response.data && err.response.data.errorCode) || '');
    // Sequential routing: recipient 2 can't open the envelope before 1 signs.
    if (/RECIPIENT_NOT_IN_SEQUENCE|OUT_OF_SEQUENCE/i.test(code)) {
      throw contractError('not_your_turn', 'This purchaser can sign once the previous purchaser has finished');
    }
    throw wrapApiError(err, 'signing view');
  }
  if (!d || !d.url) throw contractError('envelope_failed', 'DocuSign returned no signing URL');
  return { url: d.url };
}

// ---------------------------------------------------------------------------
// Pure helpers (implemented)
// ---------------------------------------------------------------------------

function headerGetter(headers) {
  if (!headers) return () => undefined;
  if (typeof headers === 'function') return headers;
  if (typeof headers.get === 'function') return (n) => headers.get(n);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return (n) => lower[String(n).toLowerCase()];
}

/**
 * Verify a Connect delivery: base64(HMAC-SHA256(key, rawBodyBytes)) must equal
 * one of the X-DocuSign-Signature-N headers, for any configured key (key
 * rotation = several keys and several headers). Raw Buffer only — the body is
 * never re-serialised. Constant-time compare after a length check.
 * @param {{rawBody: Buffer, headers: object|Function, keys: string[]}} a
 *        headers: Express req.headers, a Headers object, or a getter fn
 * @returns {{ok: true, keyIndex: number, header: string} | {ok: false, reason: 'no_keys'|'no_body'|'no_signature'|'mismatch'}}
 */
function verifyConnectHmac({ rawBody, headers, keys }) {
  const keyList = (keys || []).filter(Boolean);
  if (!keyList.length) return { ok: false, reason: 'no_keys' };
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return { ok: false, reason: 'no_body' };
  const get = headerGetter(headers);
  const sigs = [];
  for (let i = 1; i <= 10; i += 1) {
    const h = get(`x-docusign-signature-${i}`);
    if (h) sigs.push({ header: `X-DocuSign-Signature-${i}`, value: Buffer.from(String(h).trim()) });
  }
  if (!sigs.length) return { ok: false, reason: 'no_signature' };
  for (let k = 0; k < keyList.length; k += 1) {
    const expected = Buffer.from(crypto.createHmac('sha256', keyList[k]).update(rawBody).digest('base64'));
    for (const s of sigs) {
      if (s.value.length === expected.length && crypto.timingSafeEqual(s.value, expected)) {
        return { ok: true, keyIndex: k, header: s.header };
      }
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * Flatten a JSON SIM Connect payload. The eventId is stable across
 * redeliveries of the same message (WebhookEvent dedupe key).
 * @param {object} body
 * @returns {{event: string, envelopeId: string, accountId: string, recipientId: string,
 *   status: string, generatedDateTime: string, contractId: string, eventId: string}}
 */
function normaliseConnectPayload(body) {
  const b = body || {};
  const data = b.data || {};
  const summary = data.envelopeSummary || {};
  const envelopeId = String(data.envelopeId || summary.envelopeId || '');
  const event = String(b.event || '');
  const generatedDateTime = String(b.generatedDateTime || '');
  const recipientId = data.recipientId != null ? String(data.recipientId) : '';
  let contractId = '';
  const cf = (summary.customFields && summary.customFields.textCustomFields) || [];
  for (const f of cf) if (f && f.name === 'contractId') contractId = String(f.value || '');
  const eventId = crypto
    .createHash('sha256')
    .update([envelopeId, event, generatedDateTime, recipientId].join('|'))
    .digest('hex');
  return {
    event,
    envelopeId,
    accountId: String(data.accountId || ''),
    recipientId,
    status: String(summary.status || '').toLowerCase(),
    generatedDateTime,
    contractId,
    eventId,
  };
}

/**
 * Read the monitoring package the primary purchaser chose. Prefers the
 * recipients' radioGroupTabs (selected === 'true'), falls back to form_data
 * (group reported under its groupName).
 * @param {{recipients?: {signers?: object[]}, formData?: {formData?: object[], recipientFormData?: object[]}}} a
 * @returns {{package: 'basic'|'smart'|null, source: 'tabs'|'form_data'|null, raw: string|null}}
 *          raw = the selected value even when it isn't a valid package
 */
function extractPackageChoice({ recipients, formData } = {}) {
  let raw = null;
  for (const s of (recipients && recipients.signers) || []) {
    const groups = (s.tabs && s.tabs.radioGroupTabs) || [];
    for (const g of groups) {
      if (g.groupName !== PACKAGE_GROUP) continue;
      const sel = (g.radios || []).find((r) => String(r.selected) === 'true');
      if (sel) {
        raw = String(sel.value || '');
        if (isValidPackage(raw)) return { package: raw, source: 'tabs', raw };
      }
    }
  }
  const lists = [];
  if (formData) {
    lists.push(formData.formData || []);
    for (const r of formData.recipientFormData || []) lists.push(r.formData || []);
  }
  for (const l of lists) {
    for (const f of l) {
      if (f && f.name === PACKAGE_GROUP && f.value) {
        const v = String(f.value);
        if (isValidPackage(v)) return { package: v, source: 'form_data', raw: v };
        if (raw == null) raw = v;
      }
    }
  }
  return { package: null, source: null, raw };
}

module.exports = {
  PACKAGE_GROUP,
  TAB_OFFSETS,
  CONNECT_EVENTS,
  connectWebhookUrl,
  getAccessToken,
  getAccount,
  verifyDocusign,
  buildEventNotification,
  buildEnvelopeDefinition,
  createEnvelope,
  getEnvelope,
  getRecipientsWithTabs,
  getFormData,
  listStatusChanges,
  findSentEnvelopesForContract,
  downloadCombined,
  downloadCertificate,
  voidEnvelope,
  resendEnvelope,
  createRecipientView,
  verifyConnectHmac,
  normaliseConnectPayload,
  extractPackageChoice,
  // test hooks
  __setHttp,
  resetCache,
};

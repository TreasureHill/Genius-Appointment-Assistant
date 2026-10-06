const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../../config/env');
const secrets = require('../secrets');
const { encrypt, decrypt } = require('../secretBox');

// OAuth 2.0 against Microsoft Entra ID for Microsoft 365 mailboxes.
// Exchange Online refuses basic-auth IMAP, so mail is read and sent through
// Microsoft Graph with tokens from an app registration the owner creates
// once (Integrations → Microsoft 365 walks through it).
//
//   delegated — "Sign in with Microsoft": authorization-code flow, we keep a
//               refresh token (encrypted) and mint access tokens from it.
//   app       — client-credentials with admin-consented *application*
//               permissions (Mail.ReadWrite, Mail.Send); no sign-in, reads the
//               mailbox named on the account.

const LOGIN = env.microsoft.loginUrl;
// OAuth `state` is signed with its own key (derived from JWT_SECRET) so it can
// never double as a login token — it travels in URLs and lands in logs.
const STATE_KEY = crypto.createHash('sha256').update(`ms-oauth-state:${env.jwtSecret}`).digest('hex');
// App-only tokens are requested for the Graph resource itself.
const GRAPH_DEFAULT_SCOPE = `${new URL(env.microsoft.graphUrl).origin}/.default`;
const BASE_SCOPES = ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'];
const SHARED_SCOPES = ['Mail.ReadWrite.Shared', 'Mail.Send.Shared'];

function redirectUri() {
  return `${String(env.appUrl || '').replace(/\/+$/, '')}/api/oauth/microsoft/callback`;
}

function scopesFor({ shared } = {}) {
  return (shared ? [...BASE_SCOPES, ...SHARED_SCOPES] : BASE_SCOPES).join(' ');
}

function describeError(err) {
  const d = err?.response?.data || {};
  const desc = String(d.error_description || d.error?.message || '').split('\r\n')[0];
  if (/AADSTS7000215|invalid client secret/i.test(desc)) return 'Microsoft rejected the client secret — copy the secret *Value* (not the Secret ID) from Certificates & secrets.';
  if (/AADSTS700016/i.test(desc)) return 'Application (client) ID not found in this tenant — check the client ID and tenant.';
  if (/AADSTS90002|AADSTS900023/i.test(desc)) return 'Tenant not found — use your directory (tenant) ID or your domain, e.g. treasurehill.com.';
  if (/AADSTS65001|consent/i.test(desc)) return 'Permissions have not been consented yet. An admin needs to grant consent for the app (API permissions → Grant admin consent).';
  if (/AADSTS50011/i.test(desc)) return `Redirect URI mismatch — add ${redirectUri()} as a Web redirect URI on the app registration.`;
  if (/AADSTS70008|AADSTS700082|invalid_grant/i.test(desc) || d.error === 'invalid_grant') return 'The Microsoft sign-in has expired or was revoked — reconnect the mailbox.';
  return desc || d.error || err?.message || 'Microsoft sign-in failed';
}

// The authorize URL the browser is sent to. `state` is a short-lived JWT so
// the unauthenticated callback can trust what the signed-in owner asked for.
function buildAuthorizeUrl({ accountId = '', mailbox = '', label = '', color = '', returnTo = '', loginHint = '' } = {}) {
  const app = secrets.microsoftApp();
  if (!app.clientId) throw Object.assign(new Error('Microsoft 365 is not set up — add the app registration first.'), { status: 400 });
  const shared = Boolean(mailbox);
  const state = jwt.sign(
    { t: 'ms-oauth', accountId, mailbox, label, color, returnTo, shared, n: crypto.randomBytes(8).toString('hex') },
    STATE_KEY,
    { expiresIn: '15m', audience: 'ms-oauth-state' }
  );
  const params = new URLSearchParams({
    client_id: app.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: scopesFor({ shared }),
    state,
    prompt: 'select_account',
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${LOGIN}/${encodeURIComponent(app.tenantId || 'organizations')}/oauth2/v2.0/authorize?${params.toString()}`;
}

function verifyState(state) {
  const payload = jwt.verify(String(state || ''), STATE_KEY, { audience: 'ms-oauth-state' });
  if (payload?.t !== 'ms-oauth') throw new Error('bad state');
  return payload;
}

async function tokenRequest(form, app = secrets.microsoftApp()) {
  const body = new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...form });
  const { data } = await axios.post(`${LOGIN}/${encodeURIComponent(app.tenantId || 'organizations')}/oauth2/v2.0/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20_000,
  });
  return data;
}

async function exchangeCode(code, { shared } = {}) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    scope: scopesFor({ shared }),
  });
}

// Validate an app registration (tenant + client id + secret) by asking for an
// app-only token — succeeds whenever the secret is right, permissions or not.
async function testApp(app) {
  try {
    const data = await tokenRequest({ grant_type: 'client_credentials', scope: GRAPH_DEFAULT_SCOPE }, app);
    let roles = [];
    try {
      const claims = JSON.parse(Buffer.from(String(data.access_token).split('.')[1], 'base64url').toString('utf8'));
      roles = claims.roles || [];
    } catch {
      /* opaque token */
    }
    return { ok: true, message: 'App registration verified with Microsoft.', appRoles: roles };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

const appTokenCache = new Map(); // clientId -> { token, exp }

async function appToken({ force } = {}) {
  const app = secrets.microsoftApp();
  const hit = appTokenCache.get(app.clientId);
  if (!force && hit && hit.exp - 5 * 60_000 > Date.now()) return hit.token;
  const data = await tokenRequest({ grant_type: 'client_credentials', scope: GRAPH_DEFAULT_SCOPE });
  appTokenCache.set(app.clientId, { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

// A valid Graph access token for this mailbox. Delegated tokens are refreshed
// with the stored refresh token (Microsoft rotates it — the new one is saved).
// `force` skips the cached access token (Graph just answered 401 with it).
async function accessTokenFor(account, { force } = {}) {
  if (account.microsoft?.authMode === 'app') return appToken({ force });
  const ms = account.microsoft || {};
  const cachedToken = decrypt(ms.accessTokenEnc);
  // Keep a 5-minute margin so one sync doesn't outlive its token.
  if (!force && cachedToken && ms.accessTokenExpiresAt && new Date(ms.accessTokenExpiresAt).getTime() - 5 * 60_000 > Date.now()) {
    return cachedToken;
  }
  const refreshToken = decrypt(ms.refreshTokenEnc);
  if (!refreshToken) {
    throw Object.assign(new Error('This mailbox needs to be reconnected (Sign in with Microsoft).'), { needsAuth: true });
  }
  let data;
  try {
    data = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: ms.scopes || scopesFor({ shared: Boolean(ms.mailbox) }),
    });
  } catch (err) {
    const status = err?.response?.status;
    throw Object.assign(new Error(describeError(err)), { needsAuth: status === 400 || status === 401 });
  }
  account.microsoft.accessTokenEnc = encrypt(data.access_token);
  account.microsoft.accessTokenExpiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  if (data.refresh_token) account.microsoft.refreshTokenEnc = encrypt(data.refresh_token);
  await account.save();
  return data.access_token;
}

module.exports = {
  redirectUri,
  scopesFor,
  buildAuthorizeUrl,
  verifyState,
  exchangeCode,
  testApp,
  accessTokenFor,
  describeError,
  BASE_SCOPES,
};

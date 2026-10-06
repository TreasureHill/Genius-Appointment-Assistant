const express = require('express');
const env = require('../config/env');
const MailAccount = require('../models/MailAccount');
const msAuth = require('../services/mail/microsoftAuth');
const graph = require('../services/mail/graph');
const { encrypt } = require('../services/secretBox');
const { syncAccount } = require('../services/mail/sync');
const { normalizeEmail } = require('../services/mail/text');

// Microsoft redirects the browser here after "Sign in with Microsoft". Mounted
// outside the auth wall (it's a cross-site redirect); trust comes from the
// signed `state`, which only an authenticated owner could have minted.

const router = express.Router();

const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed'];

function safeReturn(returnTo) {
  const fallback = `${String(env.appUrl).replace(/\/+$/, '')}/integrations`;
  try {
    const u = new URL(returnTo);
    const app = new URL(env.appUrl);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.host === app.host || local) return u.toString();
  } catch {
    /* fall through */
  }
  return fallback;
}

function redirectWith(res, returnTo, params) {
  const u = new URL(safeReturn(returnTo));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  res.redirect(u.toString());
}

router.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  let st;
  try {
    st = msAuth.verifyState(state);
  } catch {
    return res.status(400).send('This sign-in link has expired. Go back to the app and click “Connect Microsoft 365” again.');
  }
  if (error) {
    return redirectWith(res, st.returnTo, {
      mailbox_error: msAuth.describeError({ response: { data: { error, error_description: errorDescription } } }),
    });
  }
  try {
    const tokens = await msAuth.exchangeCode(String(code || ''), { shared: Boolean(st.shared) });
    const me = await graph.whoAmI(tokens.access_token);
    const userEmail = normalizeEmail(me.mail || me.userPrincipalName);
    const mailboxEmail = normalizeEmail(st.mailbox) || userEmail;

    let account = st.accountId ? await MailAccount.findById(st.accountId) : null;
    // Reconnecting a mailbox: the sign-in must be for that same mailbox (an
    // account picker click on someone else would otherwise rebind it).
    if (account && account.kind === 'microsoft' && normalizeEmail(account.email) !== mailboxEmail) {
      return redirectWith(res, st.returnTo, {
        mailbox_error: `You signed in as ${userEmail}, but this mailbox is ${account.email}. Reconnect and choose ${account.email} at the Microsoft sign-in.`,
      });
    }
    if (!account) account = await MailAccount.findOne({ email: mailboxEmail });
    if (!account) {
      const count = await MailAccount.countDocuments();
      account = new MailAccount({
        kind: 'microsoft',
        email: mailboxEmail,
        label: st.label || mailboxEmail,
        displayName: st.mailbox ? '' : me.displayName || '',
        color: st.color || COLORS[count % COLORS.length],
        isDefault: count === 0,
        outgoing: { via: 'graph' },
      });
    }
    account.kind = 'microsoft';
    account.microsoft = {
      ...(account.microsoft?.toObject?.() || account.microsoft || {}),
      authMode: 'delegated',
      mailbox: st.mailbox ? mailboxEmail : '',
      userId: me.id || '',
      userPrincipalName: normalizeEmail(me.userPrincipalName),
      refreshTokenEnc: encrypt(tokens.refresh_token || ''),
      accessTokenEnc: encrypt(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
      scopes: msAuth.scopesFor({ shared: Boolean(st.shared) }),
      deltaLinks: account.microsoft?.deltaLinks || {},
    };
    account.enabled = true;
    account.sync.state = 'idle';
    account.sync.message = '';
    await account.save();
    syncAccount(account._id, { trigger: 'connect' }).catch(() => {});
    return redirectWith(res, st.returnTo, { mailbox_connected: account.email });
  } catch (err) {
    return redirectWith(res, st.returnTo, { mailbox_error: msAuth.describeError(err) });
  }
});

module.exports = router;

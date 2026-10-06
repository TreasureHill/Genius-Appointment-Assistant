const mongoose = require('mongoose');

// A mailbox shown in the unified inbox. Two kinds:
//   - 'microsoft': Microsoft 365 / Exchange Online through Microsoft Graph
//     (OAuth — Exchange Online no longer accepts IMAP passwords).
//   - 'imap': any IMAP mailbox (Gmail with an app password, Zoho, cPanel,
//     on-prem Exchange…), with its own SMTP for sending.
// Every secret is stored encrypted (services/secretBox) and never returned by
// the API.

const ServerSchema = new mongoose.Schema(
  {
    host: { type: String, default: '' },
    port: { type: Number, default: 0 },
    secure: { type: Boolean, default: true },
    user: { type: String, default: '' },
    passEnc: { type: String, default: '' },
  },
  { _id: false }
);

const MailAccountSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['microsoft', 'imap'], required: true },
    label: { type: String, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    displayName: { type: String, default: '' },
    color: { type: String, default: '#4f46e5' },
    enabled: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    signatureHtml: { type: String, default: '' },
    // How mail from this mailbox goes out:
    //   graph    — Microsoft Graph (Microsoft mailboxes; lands in Sent Items)
    //   smtp     — this mailbox's own SMTP server (below)
    //   env_smtp — the SMTP login already configured in .env
    //   resend   — Resend's API (Integrations → Resend)
    outgoing: {
      via: { type: String, enum: ['graph', 'smtp', 'env_smtp', 'resend'], default: 'smtp' },
      smtp: { type: ServerSchema, default: () => ({}) },
    },
    imap: { type: ServerSchema, default: () => ({}) },
    microsoft: {
      // delegated = "Sign in with Microsoft" (refresh token for one user);
      // app = client-credentials with admin-consented application permissions.
      authMode: { type: String, enum: ['delegated', 'app'], default: 'delegated' },
      // Mailbox to read when it isn't the signed-in user's own (a shared
      // mailbox, or the target mailbox in app mode). Blank = /me.
      mailbox: { type: String, default: '' },
      userId: { type: String, default: '' },
      userPrincipalName: { type: String, default: '' },
      refreshTokenEnc: { type: String, default: '' },
      accessTokenEnc: { type: String, default: '' },
      accessTokenExpiresAt: { type: Date, default: null },
      scopes: { type: String, default: '' },
      // Microsoft Graph delta links per well-known folder.
      deltaLinks: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    sync: {
      state: { type: String, enum: ['idle', 'syncing', 'ok', 'error', 'needs_auth'], default: 'idle' },
      message: { type: String, default: '' },
      lastSyncAt: { type: Date, default: null },
      lastOkAt: { type: Date, default: null },
      // IMAP: { [folderRole]: { path, uidValidity, lastUid } }
      folders: { type: mongoose.Schema.Types.Mixed, default: {} },
      initialDone: { type: Boolean, default: false },
      messageCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true, minimize: false }
);

MailAccountSchema.methods.toPublic = function toPublic() {
  const a = this.toObject ? this.toObject() : this;
  return {
    _id: a._id,
    kind: a.kind,
    label: a.label,
    email: a.email,
    displayName: a.displayName,
    color: a.color,
    enabled: a.enabled,
    isDefault: a.isDefault,
    signatureHtml: a.signatureHtml,
    outgoing: {
      via: a.outgoing?.via,
      smtp: {
        host: a.outgoing?.smtp?.host || '',
        port: a.outgoing?.smtp?.port || 0,
        secure: a.outgoing?.smtp?.secure !== false,
        user: a.outgoing?.smtp?.user || '',
        passSet: Boolean(a.outgoing?.smtp?.passEnc),
      },
    },
    imap: {
      host: a.imap?.host || '',
      port: a.imap?.port || 0,
      secure: a.imap?.secure !== false,
      user: a.imap?.user || '',
      passSet: Boolean(a.imap?.passEnc),
    },
    microsoft:
      a.kind === 'microsoft'
        ? {
            authMode: a.microsoft?.authMode,
            mailbox: a.microsoft?.mailbox || '',
            userPrincipalName: a.microsoft?.userPrincipalName || '',
            connected: Boolean(a.microsoft?.refreshTokenEnc) || a.microsoft?.authMode === 'app',
          }
        : null,
    sync: a.sync,
    createdAt: a.createdAt,
  };
};

module.exports = mongoose.model('MailAccount', MailAccountSchema);

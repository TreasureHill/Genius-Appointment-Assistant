// Server settings for common IMAP providers, so adding a mailbox is "pick a
// provider, paste the password". Microsoft 365 / Exchange Online is not here:
// it needs the Microsoft 365 (Graph) connector.

const PRESETS = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Use a Google App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password.',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    note: 'Enable IMAP access in Zoho Mail settings. Accounts with 2FA need an application-specific password.',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: 'Generate an app password in Yahoo Account Security.',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    note: 'Use an app-specific password from appleid.apple.com.',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    note: 'Create an app password in Fastmail → Settings → Privacy & Security.',
  },
  {
    id: 'exchange',
    label: 'Exchange Server (on-premises)',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    note: 'Your IT team must have IMAP enabled on the Exchange server. For Microsoft 365 use the Microsoft 365 connector instead.',
  },
  {
    id: 'custom',
    label: 'Other IMAP provider',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    note: '',
  },
];

// Best guess at the IMAP host that pairs with an SMTP host:
// smtp.example.com -> imap.example.com, mail.example.com stays.
function guessImapHost(smtpHost) {
  const h = String(smtpHost || '').trim().toLowerCase();
  if (!h) return '';
  if (/office365|outlook/.test(h)) return 'outlook.office365.com';
  if (h.startsWith('smtp.')) return `imap.${h.slice(5)}`;
  if (h.startsWith('smtpout.')) return `imap.${h.slice(8)}`;
  return h;
}

// Exchange Online / Outlook.com can't be read with an IMAP password.
function isMicrosoftHost(host) {
  return /office365\.com|outlook\.com|protection\.outlook|exchange\.microsoft/i.test(String(host || ''));
}

module.exports = { PRESETS, guessImapHost, isMicrosoftHost };

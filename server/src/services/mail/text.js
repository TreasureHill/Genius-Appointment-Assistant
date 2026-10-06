const { convert } = require('html-to-text');

// Pure helpers for email text — no I/O, unit-tested in
// services/__tests__/mail.test.js.

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// "Re: Fwd: [EXT] RE:  Lot 12 walkthrough" -> "lot 12 walkthrough"
function normalizeSubject(subject) {
  let s = String(subject || '').trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^\s*\[[^\]]{1,24}\]\s*/i, '') // [EXT] / [External] tags
      .replace(/^\s*(re|fw|fwd|aw|sv|vs|wg|tr|antw)\s*(\[\d+\])?\s*:\s*/i, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Lines that start the quoted history of a reply, across common clients:
// Gmail/Apple "On Tue, … wrote:", Outlook's "From: … Sent: …" header block
// and "-----Original Message-----", plus the underscore rule Outlook web uses.
const QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^On .{4,200}(wrote|écrit|schrieb):?\s*$/i,
  /^Le .{4,200}a écrit\s*:?\s*$/i,
];

// Drop quoted history (">"-prefixed lines and everything after a reply
// header) so a thread transcript holds each message's new text once.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (QUOTE_MARKERS.some((re) => re.test(t))) break;
    // "On Tue, Oct 7, 2025 at 9:14 AM Jane Doe <jane@x.com>" + "wrote:" on
    // the next line (Gmail wraps long headers).
    if (/^On .{4,200}$/i.test(t) && /^(.{0,80})?wrote:?\s*$/i.test((lines[i + 1] || '').trim())) break;
    // Outlook: "From: Name <a@b>" followed within 4 lines by "Sent:"/"Date:".
    if (/^\*?From:\*?\s.+/i.test(t)) {
      const ahead = lines.slice(i + 1, i + 5).map((l) => l.trim());
      if (ahead.some((l) => /^\*?(Sent|Date):\*?\s/i.test(l))) break;
    }
    if (/^>/.test(t)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function htmlToText(html) {
  if (!html) return '';
  try {
    return convert(String(html), {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'table', format: 'block' },
        { selector: 'tr', format: 'block' },
        { selector: 'td', format: 'inline' },
        ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => ({ selector: h, options: { uppercase: false } })),
      ],
    })
      .replace(/ /g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function snippetFrom(text, max = 180) {
  const flat = stripQuoted(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Plain text (an AI draft) -> simple email HTML: blank lines split
// paragraphs, single newlines become <br>.
function textToHtml(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// "Jane Doe <jane@x.com>, bob@y.com" or [{name,email}] -> [{name,email}]
function parseAddressList(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((a) => (typeof a === 'string' ? parseAddressList(a)[0] : { name: a?.name || '', email: normalizeEmail(a?.email || a?.address) }))
      .filter((a) => a && a.email);
  }
  const out = [];
  for (const part of String(input).split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    if (m) out.push({ name: m[1].trim(), email: normalizeEmail(m[2]) });
    else if (/@/.test(p)) out.push({ name: '', email: normalizeEmail(p) });
  }
  return out;
}

function formatAddress(a) {
  if (!a || !a.email) return '';
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

// First name for greetings: "Doe, Jane" -> "Jane", "jane.doe@x" -> "Jane".
function firstNameOf(person) {
  const name = String(person?.name || '').trim();
  if (name) {
    if (name.includes(',')) return name.split(',')[1].trim().split(/\s+/)[0] || name;
    return name.split(/\s+/)[0];
  }
  const local = String(person?.email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}

// "Re: <subject>" without stacking prefixes.
function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

function forwardSubject(subject) {
  const s = String(subject || '').trim();
  return /^(fw|fwd)\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

module.exports = {
  normalizeEmail,
  normalizeSubject,
  stripQuoted,
  htmlToText,
  snippetFrom,
  escapeHtml,
  textToHtml,
  parseAddressList,
  formatAddress,
  firstNameOf,
  replySubject,
  forwardSubject,
};

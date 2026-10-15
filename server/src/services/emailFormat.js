const addressparser = require('nodemailer/lib/addressparser');

// Pure helpers that shape an outgoing email: who it is from, who is on To vs
// CC, link colours, and the plain-text part. No DB or network, so they can be
// unit-tested (services/__tests__/emailFormat.test.js).

// The name homeowners see in their inbox. Without one, mail clients show the
// bare mailbox ("mariyama"). Editable in Settings → Email (SMTP).
const DEFAULT_FROM_NAME = 'Mariyam Amir - Treasure Hill';

// Blue for every link. Mail clients paint links they have no inline colour
// for with their own styles, and clicked ones turn purple (Outlook's
// "FollowedHyperlink", the browser's :visited). An inline colour on the <a>
// itself wins over both.
const LINK_COLOR = '#0000EE';

// SMTP_FROM may be a bare address ("mariyama@treasurehill.com") or carry its
// own name ('"Genius" <no-reply@x.com>'). The Settings name wins; blank falls
// back to the name in SMTP_FROM, then to the bare address.
function buildFrom(smtpFrom, fromName) {
  const raw = String(smtpFrom || '').trim();
  if (!raw) return undefined;
  const parsed = addressparser(raw)[0] || {};
  const address = parsed.address || raw;
  const name = String(fromName || '').trim() || String(parsed.name || '').trim();
  return name ? { name, address } : address;
}

// "Name <address>" for display.
function formatFrom(from) {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

// One email to several people on a lot: the first goes on To, everyone else
// is CC'd. Accepts an array or a comma-separated string; drops blanks and
// repeats (case-insensitive).
function splitRecipients(addresses) {
  const list = (Array.isArray(addresses) ? addresses : [addresses])
    .flatMap((a) => String(a || '').split(','))
    .map((a) => a.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const a of list) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  return { to: unique[0] || '', cc: unique.slice(1).join(', ') };
}

function toHex(r, g, b) {
  return `#${[r, g, b].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// Inline styles from the rich-text editor come out as rgb(0, 0, 238); some
// Outlook builds ignore rgb() and fall back to their own colours. Use hex.
function rgbToHexInStyles(html) {
  return String(html || '').replace(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (attr, q, css) => {
    const fixed = css.replace(/rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/gi, (_, r, g, b) => toHex(r, g, b));
    return `style=${q}${fixed}${q}`;
  });
}

// Give every link that has no colour of its own an inline blue (and an
// underline), so it stays blue after it is clicked. Links that already set a
// colour (a white button label, say) are left alone.
function styleLinks(html) {
  return String(html || '').replace(/<a\b([^>]*)>/gi, (tag, attrs) => {
    if (!/\bhref\s*=/i.test(attrs)) return tag;
    const m = attrs.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!m) return `<a${attrs} style="color:${LINK_COLOR};text-decoration:underline;">`;
    if (/(^|;)\s*color\s*:/i.test(m[2])) return tag;
    const css = m[2].trim();
    const merged = `${css}${css && !css.endsWith(';') ? ';' : ''}color:${LINK_COLOR};`;
    return `<a${attrs.replace(m[0], `style=${m[1]}${merged}${m[1]}`)}>`;
  });
}

// The HTML part as it goes on the wire.
function prepareHtml(html) {
  if (!html) return html;
  return styleLinks(rgbToHexInStyles(html));
}

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (code === 160) return ' ';
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const named = NAMED_ENTITIES[e.toLowerCase()];
    return named != null ? named : m;
  });
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');
const squash = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();
const bareUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

// A link in plain text: just the text when it already shows where it goes
// ("Genius@treasurehill.com", "www.treasurehill.com"), else "text (url)".
function linkText(href, inner) {
  const label = squash(inner);
  const url = decodeEntities(String(href || '').trim());
  if (!url || url.startsWith('#') || /^javascript:/i.test(url)) return label;
  if (/^mailto:/i.test(url)) {
    const addr = url.slice(7).split('?')[0];
    if (!label) return addr;
    return label.toLowerCase().includes(addr.toLowerCase()) ? label : `${label} (${addr})`;
  }
  if (/^tel:/i.test(url)) {
    const num = url.slice(4);
    if (!label) return num;
    const last10 = (x) => x.replace(/\D/g, '').slice(-10);
    return last10(label) && last10(label) === last10(num) ? label : `${label} (${num})`;
  }
  if (!label) return url;
  return bareUrl(label) === bareUrl(url) ? label : `${label} (${url})`;
}

// Readable plain text from an email's HTML: paragraphs separated by a blank
// line, list items as bullets, links spelled out, entities decoded. This is
// the text/plain part of every email that has no hand-written plain text, and
// what the Queue / Activity previews show.
function htmlToText(html) {
  let s = String(html || '');
  if (!s.trim()) return '';
  // Editors that write one <p> per line mark paragraph breaks with an empty
  // <p><br></p>; there a closing </p> is a line break, not a paragraph break.
  const linePerP = /<p[^>]*>\s*<br\s*\/?>\s*<\/p>/i.test(s);
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, '')
    // Whitespace in HTML source carries no meaning; structure comes from tags.
    .replace(/\s+/g, ' ')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
      const m = attrs.match(/\bhref\s*=\s*(["'])([\s\S]*?)\1/i);
      return linkText(m ? m[2] : '', inner);
    })
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let n = 0;
      const items = inner.replace(/<li\b([^>]*)>/gi, (__, attrs) =>
        /data-list\s*=\s*["']bullet/i.test(attrs) ? '\n• ' : `\n${++n}. `
      );
      return `\n${items}\n\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n----------\n\n')
    .replace(/<\/p>/gi, linePerP ? '\n' : '\n\n')
    .replace(/<\/(h[1-6]|blockquote|table)>/gi, '\n\n')
    .replace(/<\/(div|tr|td|th)>/gi, '\n');
  s = decodeEntities(stripTags(s));
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  DEFAULT_FROM_NAME,
  LINK_COLOR,
  buildFrom,
  formatFrom,
  splitRecipients,
  styleLinks,
  rgbToHexInStyles,
  prepareHtml,
  decodeEntities,
  htmlToText,
};

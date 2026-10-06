import { useEffect, useMemo, useRef, useState } from 'react';
import { escapeHtml } from '../../mailUtil.jsx';
import Icon from '../ui/Icon.jsx';

// Elements that start the quoted history in replies from common clients.
const QUOTE_SELECTORS = [
  '.gmail_quote',
  '.gai-quote',
  '#divRplyFwdMsg',
  '#appendonsend',
  'blockquote[type="cite"]',
  '.yahoo_quoted',
  '.moz-cite-prefix',
  'div[style*="border-top:solid #E1E1E1"]',
  'div[style*="border-top: solid #E1E1E1"]',
];

// Neutralise what a sandbox alone doesn't: links get rel=noopener (an opened
// page can't reach back and redirect this tab), and <meta refresh> / <base>
// can't navigate the frame or retarget links.
function sanitize(doc) {
  doc.querySelectorAll('meta[http-equiv], base').forEach((el) => {
    if (el.tagName === 'BASE' || /refresh|content-security-policy|set-cookie/i.test(el.getAttribute('http-equiv') || '')) el.remove();
  });
  doc.querySelectorAll('a[href], area[href]').forEach((a) => {
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('target', '_blank');
  });
  doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'));
  return doc;
}

function cleanHtml(html) {
  if (!html || typeof DOMParser === 'undefined') return html;
  const doc = sanitize(new DOMParser().parseFromString(html, 'text/html'));
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

// Split an HTML body into what's new and the quoted tail.
function splitHtmlQuote(html) {
  if (!html || typeof DOMParser === 'undefined') return { main: html, hasQuote: false };
  const doc = sanitize(new DOMParser().parseFromString(html, 'text/html'));
  const marker = doc.querySelector(QUOTE_SELECTORS.join(','));
  if (!marker || !doc.body.contains(marker)) return { main: `<!doctype html>${doc.documentElement.outerHTML}`, hasQuote: false };
  // Remove the marker and everything after it, at its level and each level up.
  let node = marker;
  const prev = marker.previousElementSibling;
  if (prev && prev.tagName === 'HR') prev.remove();
  while (node && node !== doc.body) {
    let sib = node.nextSibling;
    while (sib) {
      const next = sib.nextSibling;
      sib.remove();
      sib = next;
    }
    const parent = node.parentNode;
    if (node === marker) node.remove();
    node = parent;
  }
  if (!doc.body.textContent.trim() && !doc.body.querySelector('img')) return { main: cleanHtml(html), hasQuote: false };
  return { main: `<!doctype html>${doc.documentElement.outerHTML}`, hasQuote: true };
}

const TEXT_QUOTE = /^(On .{4,200}wrote:?|-{2,}\s*Original Message\s*-{2,}|_{10,}|From:\s.+)$/im;

function splitTextQuote(text) {
  const t = String(text || '');
  const m = t.match(TEXT_QUOTE);
  let main = m ? t.slice(0, m.index) : t;
  // Trailing ">" lines.
  main = main.replace(/(\n>.*)+\s*$/, '');
  return { main: main.trimEnd(), hasQuote: main.trim().length < t.trim().length };
}

function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1">$1</a>');
}

const BASE_CSS = `
  html,body{margin:0;padding:0;background:transparent}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;word-wrap:break-word;overflow-wrap:anywhere;overflow:hidden}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:#4f46e5}
  blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #e2e8f0;color:#475569}
  pre.gai-plain{white-space:pre-wrap;font:inherit;margin:0}
  p{margin:0 0 .8em}
`;

// Renders an email body in a sandboxed iframe: scripts never run (no
// allow-scripts + a CSP), links open in a new tab, remote images stay
// blocked until asked for, and the frame grows to fit its content.
export default function MessageBody({ html, text, allowImages, onAllowImages }) {
  const [showQuote, setShowQuote] = useState(false);
  const frame = useRef(null);
  const [height, setHeight] = useState(40);

  const { main, full, hasQuote, hasRemote } = useMemo(() => {
    if (html) {
      const split = splitHtmlQuote(html);
      return {
        ...split,
        full: cleanHtml(html),
        hasRemote: /<img[^>]+src=["']?https?:|url\(\s*["']?https?:|<link[^>]+href=["']?https?:|@import\s/i.test(html),
      };
    }
    const split = splitTextQuote(text);
    return { ...split, full: '', hasRemote: false };
  }, [html, text]);

  const srcDoc = useMemo(() => {
    // Remote images, stylesheets and fonts can all report that the email was
    // opened — they load only after "Show images".
    const remote = allowImages ? ' https: http:' : '';
    const csp = `default-src 'none'; img-src data: cid:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}; media-src data:; form-action 'none';`;
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${BASE_CSS}</style>`;
    let body;
    if (html) body = showQuote ? full : main;
    else body = `<pre class="gai-plain">${linkify(escapeHtml(showQuote ? text : main))}</pre>`;
    // Put our head first; the message's own <head>/<html> are tolerated by the parser.
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  }, [html, text, main, full, showQuote, allowImages]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    let ro;
    const measure = () => {
      try {
        const doc = el.contentDocument;
        if (!doc?.body) return;
        const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight || 0);
        setHeight(Math.min(Math.max(h + 4, 24), 20000));
      } catch {
        /* cross-origin — keep last height */
      }
    };
    const onLoad = () => {
      measure();
      try {
        ro = new ResizeObserver(measure);
        ro.observe(el.contentDocument.body);
        el.contentDocument.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
      } catch {
        /* ignore */
      }
    };
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div className="msg-body">
      {hasRemote && !allowImages && (
        <div className="msg-images">
          <Icon name="image_off" size={14} />
          Remote images and styles are hidden to protect your privacy.
          <button type="button" className="link-btn" onClick={onAllowImages}>
            Show images
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        title="Email message"
        className="msg-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        style={{ height }}
      />
      {hasQuote && (
        <button type="button" className="quote-toggle" onClick={() => setShowQuote((s) => !s)} title={showQuote ? 'Hide quoted text' : 'Show quoted text'}>
          <Icon name="more" size={16} />
        </button>
      )}
    </div>
  );
}

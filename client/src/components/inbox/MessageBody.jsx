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

// Split an HTML body into what's new and the quoted tail.
function splitHtmlQuote(html) {
  if (!html || typeof DOMParser === 'undefined') return { main: html, hasQuote: false };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const marker = doc.querySelector(QUOTE_SELECTORS.join(','));
  if (!marker || !doc.body.contains(marker)) return { main: html, hasQuote: false };
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
  if (!doc.body.textContent.trim() && !doc.body.querySelector('img')) return { main: html, hasQuote: false };
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

  const { main, hasQuote, hasRemote } = useMemo(() => {
    if (html) {
      const split = splitHtmlQuote(html);
      return { ...split, hasRemote: /<img[^>]+src=["']?https?:|url\(\s*["']?https?:/i.test(html) };
    }
    const split = splitTextQuote(text);
    return { ...split, hasRemote: false };
  }, [html, text]);

  const srcDoc = useMemo(() => {
    const imgSrc = allowImages ? 'data: cid: https: http:' : 'data: cid:';
    const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline' https:; font-src data: https:; media-src data:;`;
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${BASE_CSS}</style>`;
    let body;
    if (html) body = showQuote ? html : main;
    else body = `<pre class="gai-plain">${linkify(escapeHtml(showQuote ? text : main))}</pre>`;
    // Put our head first; the message's own <head>/<html> are tolerated by the parser.
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  }, [html, text, main, showQuote, allowImages]);

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
          Remote images are hidden to protect your privacy.
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

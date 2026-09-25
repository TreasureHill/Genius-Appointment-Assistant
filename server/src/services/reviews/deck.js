// The weekly .pptx, in the shape of the manual deck: cover → Key Metrics →
// Technician Performance Highlights → All-Time Technician Review → Customer
// Review Log. Built with pptxgenjs from the same stats object the page shows.
const PptxGenJS = require('pptxgenjs');
const { formatRange } = require('./stats');

const W = 13.333;
const H = 7.5;
const FONT = 'Calibri';
const C = {
  bg: 'DCDCDC',
  card: 'E4E4E4',
  white: 'FFFFFF',
  black: '111111',
  muted: '6B6B6B',
  gold: 'FFD43B',
  starOff: 'C4C4C4',
};

const SHADOW = { type: 'outer', blur: 6, offset: 3, angle: 45, color: '000000', opacity: 0.16 };

function card(pptx, slide, x, y, w, h, { fill = C.card, shadow = true, radius = 0.07 } = {}) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    fill: { color: fill },
    line: { color: fill, width: 0 },
    rectRadius: radius,
    ...(shadow ? { shadow: SHADOW } : {}),
  });
}

// paras: [{ text, size, bold, italic, color, spaceAfter }]
function text(slide, x, y, w, h, paras, { align = 'center', valign = 'top' } = {}) {
  const runs = paras.map((p, i) => ({
    text: String(p.text == null ? '' : p.text),
    options: {
      fontSize: p.size || 14,
      bold: Boolean(p.bold),
      italic: Boolean(p.italic),
      color: p.color || C.black,
      fontFace: FONT,
      align,
      breakLine: i < paras.length - 1,
      ...(p.spaceAfter != null ? { paraSpaceAfter: p.spaceAfter } : {}),
    },
  }));
  slide.addText(runs, { x, y, w, h, valign, align, fontFace: FONT, margin: [1.5, 3.6, 1.5, 3.6] });
}

function stars(pptx, slide, centerX, top, { size = 0.3, gap = 0.06, filled = 5, total = 5 } = {}) {
  const totalW = total * size + (total - 1) * gap;
  let x = centerX - totalW / 2;
  for (let i = 0; i < total; i++) {
    const color = i < filled ? C.gold : C.starOff;
    slide.addShape(pptx.ShapeType.star5, { x, y: top, w: size, h: size, fill: { color }, line: { color, width: 0 } });
    x += size + gap;
  }
  return totalW;
}

function title(slide, t) {
  text(slide, 0.75, 0.45, W - 1.5, 0.9, [{ text: t, size: 36, bold: true }], { valign: 'middle' });
}

function blank(pptx) {
  const s = pptx.addSlide();
  s.background = { color: C.bg };
  return s;
}

function lines(str, charsPerLine) {
  return String(str || '')
    .split('\n')
    .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / charsPerLine)), 0);
}

function truncate(str, maxChars) {
  const t = String(str || '').split(/\s+/).join(' ').trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, Math.max(1, maxChars - 1)).replace(/\s+\S*$/, '');
  return `${cut.replace(/[.,;:]+$/, '')}…`;
}

function threeCards({ top = 1.85, height = 3.55, width = 3.35, gap = 0.65 } = {}) {
  const total = 3 * width + 2 * gap;
  const left = (W - total) / 2;
  return [0, 1, 2].map((i) => ({ x: left + i * (width + gap), y: top, w: width, h: height }));
}

function fmtDate(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d));
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

function cover(pptx, stats, { companyName, reportTitle }) {
  const s = blank(pptx);
  text(s, W - 4.25, 0.5, 3.5, 0.5, [{ text: companyName, size: 16, color: C.muted }], { align: 'right' });
  text(s, 1, 1.9, W - 2, 1.2, [{ text: reportTitle, size: 54, bold: true }], { valign: 'middle' });
  text(s, 1, 3.1, W - 2, 0.8, [{ text: 'Weekly Performance Report', size: 30 }], { valign: 'middle' });
  stars(pptx, s, W / 2, 4.25, { size: 0.5, gap: 0.12, filled: 5 });
  text(s, 1, 5.05, W - 2, 0.6, [{ text: formatRange(stats.window.start, stats.window.end), size: 22 }], { valign: 'middle' });
}

function keyMetrics(pptx, stats) {
  const s = blank(pptx);
  title(s, 'Key Metrics');
  const metrics = [
    [String(stats.allTime.genius), 'Total Reviews', '(All Time)'],
    [String(stats.week.genius), 'Total Reviews', '(This Week)'],
    [String(stats.week.geniusFiveStar), '5★ Reviews', '(This Week)'],
  ];
  threeCards().forEach(({ x, y, w, h }, i) => {
    const [num, label, sub] = metrics[i];
    card(pptx, s, x, y, w, h);
    s.addShape(pptx.ShapeType.star5, { x: x + w / 2 - 0.22, y: y + 0.35, w: 0.44, h: 0.44, fill: { color: C.gold }, line: { color: C.gold, width: 0 } });
    text(s, x, y + 0.95, w, 1.0, [{ text: num, size: 48, bold: true }], { valign: 'middle' });
    text(s, x, y + 2.0, w, 0.55, [{ text: label, size: 24 }], { valign: 'middle' });
    text(s, x, y + 2.55, w, 0.45, [{ text: sub, size: 16 }], { valign: 'middle' });
  });
  const bits = [];
  const all = stats.week.total;
  if (all) {
    const other = stats.week.other;
    bits.push(`${all} review${all === 1 ? '' : 's'} landed on the listing this week` + (other ? `; ${other} not Genius-related` : ', all Genius-related'));
  }
  if (stats.listing && stats.listing.total) {
    const avg = stats.listing.rating ? `, ${Number(stats.listing.rating).toFixed(1)} average` : '';
    bits.push(`Listing overall: ${Number(stats.listing.total).toLocaleString()} reviews${avg}`);
  }
  if (bits.length) text(s, 1, 5.85, W - 2, 0.5, [{ text: bits.join(' · '), size: 13, color: C.muted }], { valign: 'middle' });
}

function highlightSlides(pptx, stats) {
  const reps = stats.reps.length ? stats.reps : [];
  for (let i = 0; i < Math.max(reps.length, 1); i += 3) {
    const chunk = reps.slice(i, i + 3);
    const s = blank(pptx);
    title(s, 'Technician Performance Highlights');
    const cards = threeCards({ top: 1.65, height: 4.7, width: 3.75, gap: 0.5 });
    if (!chunk.length) {
      text(s, 1, 3, W - 2, 1, [{ text: 'No active reps yet — add them under Reviews → Reps & matching.', size: 18, color: C.muted }]);
    }
    chunk.forEach((rep, j) => {
      const { x, y, w, h } = cards[j];
      card(pptx, s, x, y, w, h);
      text(s, x, y + 0.2, w, 0.5, [{ text: rep.name, size: 24, bold: true }], { valign: 'middle' });
      text(s, x, y + 0.68, w, 0.4, [{ text: `(${rep.week} Mention${rep.week === 1 ? '' : 's'})`, size: 14, color: C.muted }], { valign: 'middle' });
      const bodyTop = y + 1.2;
      const bodyH = h - 1.45;
      const charsPerLine = 40;
      const lineH = 0.24;
      let budget = Math.floor(bodyH / lineH);
      const paras = [];
      if (!rep.week) paras.push({ text: 'No mentions this week.', size: 12, italic: true, color: C.muted });
      for (const r of rep.highlights || []) {
        if (budget < 3) break;
        const quote = truncate(r.text, charsPerLine * (budget - 1));
        budget -= lines(quote, charsPerLine) + 1;
        paras.push({ text: quote, size: 13, spaceAfter: 8 });
        paras.push({ text: `— ${r.reviewer}`, size: 11, italic: true, color: C.muted, spaceAfter: 10 });
      }
      if (paras.length) text(s, x + 0.25, bodyTop, w - 0.5, bodyH, paras, { align: 'left' });
    });
  }
}

function allTimeSlides(pptx, stats) {
  const reps = stats.reps.slice().sort((a, b) => b.allTime - a.allTime);
  for (let i = 0; i < Math.max(reps.length, 1); i += 3) {
    const chunk = reps.slice(i, i + 3);
    const s = blank(pptx);
    title(s, 'All-Time Technician Review');
    const cards = threeCards({ top: 1.85, height: 3.75 });
    if (!chunk.length) {
      text(s, 1, 3, W - 2, 1, [{ text: 'No active reps yet.', size: 18, color: C.muted }]);
    }
    chunk.forEach((rep, j) => {
      const { x, y, w, h } = cards[j];
      card(pptx, s, x, y, w, h);
      text(s, x, y + 0.3, w, 0.5, [{ text: rep.name, size: 24, bold: true }], { valign: 'middle' });
      stars(pptx, s, x + w / 2, y + 0.9, { size: 0.32, gap: 0.07, filled: Math.round(rep.avgRating || 0) });
      text(s, x, y + 1.35, w, 0.95, [{ text: String(rep.allTime), size: 46, bold: true }], { valign: 'middle' });
      text(s, x, y + 2.3, w, 0.5, [{ text: 'Total Reviews', size: 24 }], { valign: 'middle' });
      text(s, x, y + 2.78, w, 0.4, [{ text: '(All Time)', size: 16 }], { valign: 'middle' });
      const avg = rep.allTime ? `${Number(rep.avgRating).toFixed(2)} average rating` : 'no reviews yet';
      text(s, x, y + 3.2, w, 0.4, [{ text: avg, size: 12, color: C.muted }], { valign: 'middle' });
    });
  }
}

function reviewLog(pptx, stats, tz) {
  const reviews = (stats.weekReviews || []).filter((r) => r.genius).slice().sort((a, b) => new Date(a.effectiveAt) - new Date(b.effectiveAt));
  const left = 0.75;
  const width = W - 1.5;
  const firstTop = 1.45;
  const bottom = H - 0.35;
  const gap = 0.2;
  const charsPerLine = 155;
  const lineH = 0.215;
  const headerH = 0.74;
  const pad = 0.12;
  const maxBodyLines = Math.floor((bottom - firstTop - headerH - pad) / lineH);

  let page = 0;
  let idx = 0;
  while (idx < reviews.length || (page === 0 && !reviews.length)) {
    page += 1;
    const s = blank(pptx);
    title(s, `Customer Review Log${page > 1 ? ` (${page})` : ''}`);
    let y = firstTop;
    if (!reviews.length) {
      text(s, left, 2.5, width, 1, [{ text: 'No Genius-related reviews were posted or edited this week.', size: 18, color: C.muted }]);
      break;
    }
    while (idx < reviews.length) {
      const r = reviews[idx];
      const body = r.text ? truncate(r.text, charsPerLine * maxBodyLines) : '(no comment)';
      const n = lines(body, charsPerLine);
      const cardH = headerH + n * lineH + pad;
      if (y + cardH > bottom && y > firstTop) break;
      card(pptx, s, left, y, width, cardH, { fill: C.white, shadow: false, radius: 0.02 });
      text(s, left + 0.25, y + 0.12, width - 0.5, 0.35, [{ text: r.reviewer, size: 14, bold: true }], { align: 'left' });
      const starW = stars(pptx, s, left + 0.25 + 0.7, y + 0.5, { size: 0.22, gap: 0.04, filled: Math.round(Number(r.rating) || 0) });
      const edited = r.editedAt && r.postedAt && new Date(r.editedAt) > new Date(r.postedAt);
      const when = `${edited ? 'Edited ' : ''}${fmtDate(r.effectiveAt, tz)}`;
      text(s, left + 0.25 + starW + 0.15, y + 0.44, 5, 0.35, [{ text: when, size: 11, color: C.muted }], { align: 'left' });
      text(s, left + 0.25, y + headerH - 0.05, width - 0.5, n * lineH + 0.15, [{ text: body, size: 12 }], { align: 'left' });
      y += cardH + gap;
      idx += 1;
    }
  }
}

// → Buffer (.pptx). `stats` comes from computeStats(); `listing` is the
// listing's own totals when known.
async function buildDeck({ stats, companyName = 'TREASURE HILL', reportTitle = 'Genius Google Reviews', tz = 'UTC' } = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = companyName;
  pptx.title = `${reportTitle} — ${formatRange(stats.window.start, stats.window.end)}`;
  const branding = { companyName, reportTitle };
  cover(pptx, stats, branding);
  keyMetrics(pptx, stats);
  highlightSlides(pptx, stats);
  allTimeSlides(pptx, stats);
  reviewLog(pptx, stats, tz);
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

function deckFilename(stats) {
  return `Genius_Google_Reviews_${stats.window.start}_to_${stats.window.end}.pptx`;
}

module.exports = { buildDeck, deckFilename, truncate, lines };

const Handlebars = require('handlebars');

const cache = new Map();
function compile(src) {
  if (!src) return () => '';
  if (cache.has(src)) return cache.get(src);
  const fn = Handlebars.compile(src, { noEscape: false });
  cache.set(src, fn);
  return fn;
}

function firstNameOf(name) {
  return (name || '').trim().split(/\s+/)[0] || '';
}

function buyerView(b) {
  if (!b || !(b.name || b.email || b.phone)) {
    return { name: '', firstName: '', email: '', phone: '', role: '', present: false };
  }
  return {
    name: b.name || '',
    firstName: firstNameOf(b.name),
    email: b.email || '',
    phone: b.phone || '',
    role: b.role || '',
    present: true,
  };
}

// "Jane and John" if both present, otherwise "Jane," (with trailing comma)
// so templates can write `Hello {{buyersDisplay}}` and have it always look
// natural — couple greeting when there's a co-buyer, single-name + comma
// when there isn't.
function combineNames(a, b) {
  const aT = (a || '').trim();
  const bT = (b || '').trim();
  if (aT && bT) return `${aT} and ${bT}`;
  if (aT) return `${aT},`;
  if (bT) return `${bT},`;
  return '';
}

function renderContext({ project, lot, buyer, owner }) {
  const ownerCtx = owner
    ? {
        name: owner.name || '',
        email: owner.email || '',
        phone: owner.phone || '',
        calendlyUrl: owner.calendlyUrl || '',
      }
    : {};

  // Pull every buyer slot off the lot so templates can address co-buyers
  // even when the message is being sent to the primary buyer.
  const buyers = (lot && lot.buyers) || [];
  const findRole = (role) => buyers.find((x) => x.role === role) || null;
  const buyerRow = findRole('buyer');
  const coBuyerRow = findRole('coBuyer');
  const thirdBuyerRow = findRole('thirdBuyer');

  // The "current" recipient (the buyer this specific message is going to).
  // Falls back to the primary buyer slot when not given (e.g. test sends).
  const recipient = buyer || buyerRow || {};
  const buyerCtx = {
    name: recipient.name || '',
    firstName: firstNameOf(recipient.name),
    email: recipient.email || '',
    phone: recipient.phone || '',
    role: recipient.role || 'buyer',
  };

  const coBuyerCtx = buyerView(coBuyerRow);
  const thirdBuyerCtx = buyerView(thirdBuyerRow);
  const primaryCtx = buyerView(buyerRow);

  return {
    project: project ? { name: project.name, description: project.description || '' } : {},
    lot: lot
      ? {
          number: lot.lotNumber,
          address: lot.address || '',
          status: lot.status,
        }
      : {},
    buyer: buyerCtx,
    coBuyer: coBuyerCtx,
    thirdBuyer: thirdBuyerCtx,
    primaryBuyer: primaryCtx,

    // Smart combined displays. Use either the full-name or first-name
    // version depending on how formal the template is.
    buyersDisplay: combineNames(primaryCtx.name, coBuyerCtx.name),
    buyersFirstDisplay: combineNames(primaryCtx.firstName, coBuyerCtx.firstName),

    // Backwards-compatible alias so older templates using {{rep.name}} still work
    rep: ownerCtx,
    owner: ownerCtx,
  };
}

function render(src, ctx) {
  try {
    return compile(sanitizeHandlebars(src) || '')(ctx);
  } catch (err) {
    return `[template error: ${err.message}]`;
  }
}

// Rich-text editors (ReactQuill etc.) sometimes wrap parts of a {{var}}
// expression in HTML tags when the user formats around it, producing
// {{<span ...>buyer.name</span>}} which Handlebars rejects. Strip any HTML
// tags that landed inside a {{...}} block before compiling.
function sanitizeHandlebars(src) {
  if (!src) return src;
  return src.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const cleaned = expr.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    return `{{${cleaned}}}`;
  });
}

function renderTemplate(template, ctx) {
  if (!template) return { subject: '', html: '', text: '' };
  return {
    subject: render(template.subject, ctx),
    html: render(template.bodyHtml, ctx),
    text: render(template.bodyText, ctx),
  };
}

module.exports = { render, renderTemplate, renderContext };

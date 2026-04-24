const Handlebars = require('handlebars');

const cache = new Map();
function compile(src) {
  if (!src) return () => '';
  if (cache.has(src)) return cache.get(src);
  const fn = Handlebars.compile(src, { noEscape: false });
  cache.set(src, fn);
  return fn;
}

function renderContext({ project, lot, buyer, rep }) {
  return {
    project: project ? { name: project.name, description: project.description || '' } : {},
    lot: lot
      ? {
          number: lot.lotNumber,
          address: lot.address || '',
          status: lot.status,
        }
      : {},
    buyer: buyer
      ? {
          name: buyer.name || '',
          firstName: (buyer.name || '').split(/\s+/)[0] || '',
          email: buyer.email || '',
          phone: buyer.phone || '',
          role: buyer.role || 'buyer',
        }
      : {},
    rep: rep
      ? {
          name: rep.name || '',
          email: rep.email || '',
          phone: rep.phone || '',
          calendlyUrl: rep.calendlyUser
            ? `https://calendly.com/${rep.calendlyUser.replace(/^https?:\/\/calendly\.com\//, '')}`
            : '',
        }
      : {},
  };
}

function render(src, ctx) {
  try {
    return compile(src || '')(ctx);
  } catch (err) {
    return `[template error: ${err.message}]`;
  }
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

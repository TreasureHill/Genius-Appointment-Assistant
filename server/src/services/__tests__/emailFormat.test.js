/**
 * Pure-function tests for how an email goes out: the sender name, To vs CC
 * for a lot's buyers, blue links, the plain-text part, and the Genius email
 * preset that replaces the old table-built copy.
 * No DB or network — run with: npm run test:email  (from server/)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_FROM_NAME,
  buildFrom,
  formatFrom,
  splitRecipients,
  styleLinks,
  uniqueTail,
  prepareHtml,
  decodeEntities,
  htmlToText,
} = require('../emailFormat');
const { geniusAppointmentHtml, isLegacyGeniusEmail, extractCalendlyUrl, PRESETS } = require('../emailPresets');
const { renderTemplate, renderContext, combinedRecipientView } = require('../templateRender');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const legacy = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacyGeniusEmail.html'), 'utf8');

console.log('buildFrom');
t('a bare SMTP_FROM address gets the sender name', () => {
  assert.deepStrictEqual(buildFrom('mariyama@treasurehill.com', DEFAULT_FROM_NAME), {
    name: 'Mariyam Amir - Treasure Hill',
    address: 'mariyama@treasurehill.com',
  });
});
t('the Settings name wins over a name already in SMTP_FROM', () => {
  assert.deepStrictEqual(buildFrom('"Genius Appointments" <no-reply@x.com>', 'Mariyam Amir - Treasure Hill'), {
    name: 'Mariyam Amir - Treasure Hill',
    address: 'no-reply@x.com',
  });
});
t('a blank name falls back to SMTP_FROM, then to the bare address', () => {
  assert.deepStrictEqual(buildFrom('"Genius" <no-reply@x.com>', '  '), { name: 'Genius', address: 'no-reply@x.com' });
  assert.strictEqual(buildFrom('mariyama@treasurehill.com', ''), 'mariyama@treasurehill.com');
  assert.strictEqual(buildFrom('', 'Anyone'), undefined);
});
t('formatFrom shows what the inbox will show', () => {
  assert.strictEqual(
    formatFrom(buildFrom('mariyama@treasurehill.com', DEFAULT_FROM_NAME)),
    'Mariyam Amir - Treasure Hill <mariyama@treasurehill.com>'
  );
  assert.strictEqual(formatFrom('a@x.com'), 'a@x.com');
});

console.log('splitRecipients');
t('first buyer on To, the second CC\'d', () => {
  assert.deepStrictEqual(splitRecipients(['jane@x.com', 'john@y.com']), { to: 'jane@x.com', cc: 'john@y.com' });
});
t('a third buyer is CC\'d too; one buyer has no CC', () => {
  assert.deepStrictEqual(splitRecipients(['a@x.com', 'b@x.com', 'c@x.com']), { to: 'a@x.com', cc: 'b@x.com, c@x.com' });
  assert.deepStrictEqual(splitRecipients(['a@x.com']), { to: 'a@x.com', cc: '' });
});
t('old comma-joined To strings split the same way; repeats and blanks drop out', () => {
  assert.deepStrictEqual(splitRecipients('a@x.com, b@x.com'), { to: 'a@x.com', cc: 'b@x.com' });
  assert.deepStrictEqual(splitRecipients(['a@x.com, b@x.com']), { to: 'a@x.com', cc: 'b@x.com' });
  assert.deepStrictEqual(splitRecipients(['A@x.com', '', 'a@x.com', 'b@x.com']), { to: 'A@x.com', cc: 'b@x.com' });
});

console.log('link colours');
t('a link with no colour of its own gets an inline blue', () => {
  assert.strictEqual(
    styleLinks('<a href="https://x.com">x</a>'),
    '<a href="https://x.com" style="color:#0000EE;text-decoration:underline;">x</a>'
  );
});
t('a style without a colour is extended; an explicit colour is kept', () => {
  assert.strictEqual(
    styleLinks('<a href="#" style="font-weight:bold">x</a>'),
    '<a href="#" style="font-weight:bold;color:#0000EE;">x</a>'
  );
  const button = '<a href="#" style="background-color:#1f3a93;color:#fff">Book</a>';
  assert.strictEqual(styleLinks(button), button);
});
t('the old email\'s schedule link (colour on the <strong>, not the <a>) turns blue', () => {
  const html = prepareHtml(legacy);
  const anchors = html.match(/<a\b[^>]*>/g);
  assert.strictEqual(anchors.length, 6);
  for (const a of anchors) assert.ok(/color:\s*#0000EE/i.test(a), a);
  assert.ok(!/rgb\(/.test(html), 'rgb() colours become hex');
});

console.log('signature stays visible in Gmail threads');
t('a hidden per-send token lands inside the signature, before the closing tags', () => {
  const html = uniqueTail(geniusAppointmentHtml(), 'a1b2c3');
  assert.ok(html.endsWith('www.treasurehill.com</a><span style="display:none !important;mso-hide:all;font-size:0;line-height:0;max-height:0;overflow:hidden;opacity:0;">a1b2c3</span></p>\n</div>'));
  assert.strictEqual((html.match(/a1b2c3/g) || []).length, 1);
});
t('works for table layouts and bare text, and is skipped without a token', () => {
  assert.ok(uniqueTail('<table><tr><td>Regards</td></tr></table>', 'x').startsWith('<table><tr><td>Regards<span'));
  assert.ok(uniqueTail('Regards', 'x').startsWith('Regards<span'));
  assert.strictEqual(uniqueTail('<p>Hi</p>', ''), '<p>Hi</p>');
  assert.strictEqual(uniqueTail('', 'x'), '');
});
t('the token never breaks out of its span', () => {
  assert.ok(uniqueTail('<p>Hi</p>', '"><script>1</script>').includes('>script1script</span>'));
});
t('two sends of the same email end differently; the visible text is unchanged', () => {
  const a = prepareHtml(geniusAppointmentHtml(), { tailToken: 'aaa111' });
  const b = prepareHtml(geniusAppointmentHtml(), { tailToken: 'bbb222' });
  assert.notStrictEqual(a.slice(-120), b.slice(-120));
  const strip = (h) => h.replace(/<span style="display:none[^>]*>[^<]*<\/span>/, '');
  assert.strictEqual(strip(a), prepareHtml(geniusAppointmentHtml()));
  assert.strictEqual(strip(b), prepareHtml(geniusAppointmentHtml()));
});

console.log('htmlToText');
t('entities are decoded', () => {
  assert.strictEqual(decodeEntities('home&#39;s&nbsp;setup &amp; more &#x2014; &rsquo;'), "home's setup & more — ’");
});
t('paragraphs, bullets and links read like a letter', () => {
  const text = htmlToText(
    '<p>Dear Jane,</p>\n<p>In this meeting:</p><ul><li>One</li><li>Two <strong>bold</strong></li></ul>' +
      '<p><a href="https://cal.com/x">Book here</a> or visit <a href="https://www.site.com">www.site.com</a>, ' +
      'email <a href="mailto:a@x.com">a@x.com</a>, call <a href="tel:+14165614327">+1-416-561-4327</a>.</p>' +
      '<p>Regards,<br>Mariyam</p>'
  );
  assert.strictEqual(
    text,
    'Dear Jane,\n\nIn this meeting:\n\n• One\n• Two bold\n\n' +
      'Book here (https://cal.com/x) or visit www.site.com, email a@x.com, call +1-416-561-4327.\n\nRegards,\nMariyam'
  );
});
t('numbered lists count; Quill bullet items inside <ol> stay bullets', () => {
  assert.strictEqual(htmlToText('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
  assert.strictEqual(htmlToText('<ol><li data-list="bullet">x</li><li data-list="bullet">y</li></ol>'), '• x\n• y');
});
t('one-<p>-per-line editor output keeps single line breaks', () => {
  assert.strictEqual(htmlToText('<p>Hi</p><p><br></p><p>Line one</p><p>Line two</p>'), 'Hi\n\nLine one\nLine two');
});
t('style blocks and comments never leak into the text', () => {
  assert.strictEqual(htmlToText('<style>p{color:red}</style><!-- x --><p>Hello</p>'), 'Hello');
  assert.strictEqual(htmlToText(''), '');
});

console.log('Genius appointment preset');
const jane = { role: 'buyer', name: 'Jane Doe', email: 'jane@x.com' };
const john = { role: 'coBuyer', name: 'John Smith', email: 'john@x.com' };
function renderFor(buyers) {
  const lot = { lotNumber: '42', buyers };
  const view = buyers.length > 1 ? combinedRecipientView(buyers) : buyers[0];
  return renderTemplate(
    { subject: '', bodyHtml: geniusAppointmentHtml(), bodyText: '' },
    renderContext({ project: { name: 'P' }, lot, buyer: view, owner: {} })
  );
}
t('security films are out, EV chargers are in, and it is no longer a table', () => {
  const html = geniusAppointmentHtml();
  assert.ok(!/security films/i.test(html));
  assert.ok(/<li>EV chargers<\/li>/.test(html));
  assert.ok(!/<table|<td/i.test(html));
  assert.ok(!/\]\(https?:/.test(html), 'no markdown-style link text');
});
t('every link is blue inline', () => {
  const anchors = geniusAppointmentHtml().match(/<a\b[^>]*>/g);
  assert.strictEqual(anchors.length, 6);
  for (const a of anchors) assert.ok(a.includes('color:#0000EE'), a);
  assert.strictEqual(styleLinks(geniusAppointmentHtml()), geniusAppointmentHtml());
});
t('greeting names both buyers on a shared email, one comma either way', () => {
  assert.ok(htmlToText(renderFor([jane, john]).html).startsWith('Dear Jane Doe and John Smith,\n\n'));
  assert.ok(htmlToText(renderFor([jane]).html).startsWith('Dear Jane Doe,\n\n'));
});
t('the plain-text version keeps the letter, lists and signature', () => {
  const text = htmlToText(renderFor([jane, john]).html);
  assert.ok(text.includes('As the owner of Lot # 42, scheduling a MANDATORY appointment'));
  assert.ok(text.includes('• Audio-visual integration\n• EV chargers\n• Extended Wi-Fi coverage'));
  assert.ok(text.includes('SCHEDULE YOUR APPOINTMENT HERE (https://calendly.com/mariyama-treasurehill/treasure-hill-genius)'));
  assert.ok(text.endsWith('Regards,\n\nMariyam Amir\nGenius Representative\nTREASURE HILL\nTel: 416 561 4327\n1681 Langstaff Road, Vaughan, Ontario\nmariyama@treasurehill.com | www.treasurehill.com'));
});
t('a custom Calendly link is used and attribute-escaped', () => {
  const html = geniusAppointmentHtml({ calendlyUrl: 'https://calendly.com/x/y?a=1&b="2"' });
  assert.ok(html.includes('href="https://calendly.com/x/y?a=1&amp;b=&quot;2&quot;"'));
});
t('the preset list carries it for the editor', () => {
  assert.strictEqual(PRESETS[0].key, 'genius-appointment');
  assert.strictEqual(PRESETS[0].bodyHtml, geniusAppointmentHtml());
});

console.log('legacy detection (boot migration)');
t('the old table-built email is recognised, with its Calendly link', () => {
  assert.strictEqual(isLegacyGeniusEmail(legacy), true);
  assert.strictEqual(extractCalendlyUrl(legacy), 'https://calendly.com/mariyama-treasurehill/treasure-hill-genius');
});
t('the new email, and unrelated templates, are left alone', () => {
  assert.strictEqual(isLegacyGeniusEmail(geniusAppointmentHtml()), false);
  assert.strictEqual(isLegacyGeniusEmail('<p>We install window security films.</p>'), false);
  assert.strictEqual(extractCalendlyUrl('<p>none</p>'), '');
});

console.log(`\n${passed} passed`);

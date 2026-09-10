/**
 * Pure-function tests for the per-lot recipient rendering.
 * No DB or network — run with: npm run test:render  (from server/)
 *
 * One email per lot goes to every buyer on it; the template's {{buyer.*}}
 * greeting must then read as the couple ("Hi Jane and John,") without the
 * template having to change.
 */
const assert = require('assert');
const { joinNames, combinedRecipientView, renderContext, render, firstNameOf } = require('../templateRender');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const jane = { role: 'buyer', name: 'Jane Doe', email: 'jane@x.com', phone: '+14165550101' };
const john = { role: 'coBuyer', name: 'John Smith', email: 'john@x.com', phone: '' };
const mary = { role: 'thirdBuyer', name: 'Mary Ann Lee', email: 'mary@x.com', phone: '' };

console.log('joinNames');
t('one, two, three names', () => {
  assert.strictEqual(joinNames(['Jane']), 'Jane');
  assert.strictEqual(joinNames(['Jane', 'John']), 'Jane and John');
  assert.strictEqual(joinNames(['Jane', 'John', 'Mary']), 'Jane, John and Mary');
});
t('blank names are skipped', () => {
  assert.strictEqual(joinNames(['Jane', '', null, 'John']), 'Jane and John');
  assert.strictEqual(joinNames([]), '');
});

console.log('combinedRecipientView');
t('a single buyer comes back unchanged', () => {
  assert.strictEqual(combinedRecipientView([jane]), jane);
  assert.strictEqual(combinedRecipientView([]), null);
});
t('two buyers become one recipient with joined names and the primary contact', () => {
  const v = combinedRecipientView([jane, john]);
  assert.strictEqual(v.name, 'Jane Doe and John Smith');
  assert.strictEqual(v.firstName, 'Jane and John');
  assert.strictEqual(v.email, 'jane@x.com');
  assert.strictEqual(v.phone, '+14165550101');
  assert.strictEqual(v.role, 'buyer');
  assert.strictEqual(v.combined, true);
});
t('three buyers', () => {
  assert.strictEqual(combinedRecipientView([jane, john, mary]).firstName, 'Jane, John and Mary');
});

console.log('renderContext with a combined recipient');
const lot = { lotNumber: '12', address: '18 Larkspur Way', status: 'pending', buyers: [jane, john] };
const project = { name: 'Union Village' };
t('"Hi {{buyer.firstName}}," greets the couple', () => {
  const ctx = renderContext({ project, lot, buyer: combinedRecipientView([jane, john]), owner: { name: 'Sam' } });
  assert.strictEqual(render('Hi {{buyer.firstName}},', ctx), 'Hi Jane and John,');
  assert.strictEqual(render('{{buyer.name}}', ctx), 'Jane Doe and John Smith');
  assert.strictEqual(render('{{buyer.email}}', ctx), 'jane@x.com');
});
t('a single recipient still greets by first name', () => {
  const ctx = renderContext({ project, lot, buyer: john, owner: {} });
  assert.strictEqual(render('Hi {{buyer.firstName}},', ctx), 'Hi John,');
  assert.strictEqual(render('{{buyer.email}}', ctx), 'john@x.com');
});
t('the couple helpers are unaffected', () => {
  const ctx = renderContext({ project, lot, buyer: combinedRecipientView([jane, john]), owner: {} });
  assert.strictEqual(render('{{buyersFirstDisplay}}', ctx), 'Jane and John');
  assert.strictEqual(render('{{buyersDisplay}}', ctx), 'Jane Doe and John Smith');
  assert.strictEqual(render('{{coBuyer.firstName}}', ctx), 'John');
});
t('firstNameOf', () => {
  assert.strictEqual(firstNameOf('  Mary Ann Lee '), 'Mary');
  assert.strictEqual(firstNameOf(''), '');
});

console.log(`\nAll ${passed} assertions passed ✅`);

/**
 * Pure-function tests for the ElevenLabs helpers (no network).
 * Run with: npm run test:elevenlabs  (from server/)
 *
 * Locks in the fix for "Aria didn't say my first sentence": the first
 * message / prompt overrides are substituted server-side and must accept
 * both {{first_name}} (what people naturally type — ElevenLabs' own
 * dynamic-variable spelling) and {first_name}.
 */
const assert = require('assert');
const {
  substituteVariables,
  unresolvedPlaceholders,
  buildDynamicVariables,
  describeError,
  normalizePhone,
} = require('../elevenlabs');

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const lot = { _id: '64b000000000000000000001', lotNumber: '12', address: '18 Larkspur Way', project: { name: 'Bowmanville - Lot Tracking', marketingName: 'Union Village' } };
const buyer = { name: 'Priya Natarajan', email: 'priya@example.com', phone: '4165550112' };
const vars = buildDynamicVariables({ lot, buyer, owner: { name: 'Sam', calendlyUrl: 'https://calendly.com/x' }, slotsText: 'Tue 2 PM; Wed 10 AM' });

console.log('buildDynamicVariables');
t('exposes the names the prompt uses', () => {
  assert.strictEqual(vars.first_name, 'Priya');
  assert.strictEqual(vars.lot_number, '12');
  assert.strictEqual(vars.project_name, 'Union Village');
  assert.strictEqual(vars.lot_id, '64b000000000000000000001');
  assert.strictEqual(vars.buyer_email, 'priya@example.com');
  assert.strictEqual(vars.available_slots, 'Tue 2 PM; Wed 10 AM');
});

console.log('substituteVariables');
t('double braces (the spelling in Settings) are substituted', () => {
  assert.strictEqual(
    substituteVariables('Hi {{first_name}}, this is Aria calling about Lot {{lot_number}} at {{project_name}}.', vars),
    'Hi Priya, this is Aria calling about Lot 12 at Union Village.'
  );
});
t('single braces still work, and spaces inside braces are tolerated', () => {
  assert.strictEqual(substituteVariables('Hi {first_name} / {{ lot_number }}', vars), 'Hi Priya / 12');
});
t('no stray braces are left behind (the old bug: "Hi {Priya}")', () => {
  const out = substituteVariables('Hi {{first_name}}, Lot {{lot_number}}', vars);
  assert.ok(!out.includes('{') && !out.includes('}'), out);
});
t('unknown names are left intact so typos are visible', () => {
  assert.strictEqual(substituteVariables('{{lot_numbr}} and {typo}', vars), '{{lot_numbr}} and {typo}');
});
t('null / empty values render as empty strings', () => {
  assert.strictEqual(substituteVariables('slots: {{available_slots}}.', { available_slots: null }), 'slots: .');
});
t('non-string input is passed through', () => {
  assert.strictEqual(substituteVariables(null, vars), null);
  assert.strictEqual(substituteVariables(undefined, vars), undefined);
});

console.log('unresolvedPlaceholders');
t('lists the names the call would not fill in, once each', () => {
  assert.deepStrictEqual(unresolvedPlaceholders('Hi {{first_name}} {{lot_numbr}} {typo} {{lot_numbr}}', vars), ['lot_numbr', 'typo']);
  assert.deepStrictEqual(unresolvedPlaceholders('Hi {{first_name}}', vars), []);
  assert.deepStrictEqual(unresolvedPlaceholders('', vars), []);
});

console.log('describeError');
t('reads ElevenLabs detail strings and objects', () => {
  assert.strictEqual(describeError({ response: { data: { detail: 'Override not allowed' } } }), 'Override not allowed');
  assert.strictEqual(describeError({ response: { data: { detail: { status: 'x', message: 'First message override is disabled' } } } }), 'First message override is disabled');
  assert.strictEqual(describeError(new Error('boom')), 'boom');
});

console.log('normalizePhone');
t('coerces North American numbers to E.164', () => {
  assert.strictEqual(normalizePhone('(416) 555-0112'), '+14165550112');
  assert.strictEqual(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

console.log(`\nAll ${passed} assertions passed ✅`);

// ---- Agent Security settings: reading the override toggles ----
{
  const { readOverridePermissions, previewOverrides } = require('../elevenlabs');
  const agentOff = { platform_settings: { overrides: { conversation_config_override: { agent: { first_message: false, prompt: { prompt: false } } } } } };
  const agentOn = { platform_settings: { overrides: { conversation_config_override: { agent: { first_message: true, language: true, prompt: { prompt: true, llm: false } } } } } };
  assert.deepStrictEqual(readOverridePermissions(agentOff), { firstMessage: false, prompt: false, language: false });
  assert.deepStrictEqual(readOverridePermissions(agentOn), { firstMessage: true, prompt: true, language: true });
  assert.deepStrictEqual(readOverridePermissions({}), { firstMessage: false, prompt: false, language: false }, 'missing settings read as off');
  const pv = previewOverrides({
    lot: { _id: 'x', lotNumber: '7', project: { name: 'P' } },
    buyer: { name: 'Ann Lee', phone: '+1', email: 'a@x.com' },
    aria: { firstMessage: 'Hi {{first_name}}, Lot {{lot_number}} {{nope}}', systemPrompt: 'You call {{buyer_email}}' },
  });
  assert.strictEqual(pv.firstMessage, 'Hi Ann, Lot 7 {{nope}}');
  assert.strictEqual(pv.prompt, 'You call a@x.com');
  assert.deepStrictEqual(pv.unresolved, { firstMessage: ['nope'], prompt: [] });
  console.log('readOverridePermissions / previewOverrides: ok');
}

// ---- withDeadline: the voice agent never waits longer than we promised ----
{
  const { withDeadline } = require('../ariaCall');
  const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  (async () => {
    // A fast lookup passes straight through.
    assert.deepStrictEqual(await withDeadline(sleep(5, { ok: true }), 200, () => ({ ok: false })), { ok: true });
    // A slow one falls back instead of hanging the call.
    const started = Date.now();
    const slow = await withDeadline(sleep(2000, { ok: true }), 100, () => ({ ok: false, timedOut: true }));
    assert.deepStrictEqual(slow, { ok: false, timedOut: true });
    assert.ok(Date.now() - started < 500, 'returned at the deadline, not when the work finished');
    // A rejection is handled the same way as a timeout.
    const failed = await withDeadline(Promise.reject(new Error('boom')), 500, (e) => ({ ok: false, why: e.message }));
    assert.deepStrictEqual(failed, { ok: false, why: 'boom' });
    console.log('withDeadline: ok');
  })().catch((e) => {
    console.error('withDeadline FAILED:', e);
    process.exit(1);
  });
}

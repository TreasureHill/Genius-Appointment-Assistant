/**
 * DocuSign track: signer list, envelope definition (tabs, radio group,
 * Connect eventNotification), the REST client (JWT grant, token cache,
 * consent / anchor error mapping, batching, downloads) with a fake HTTP
 * transport, the envelope sync planner and the sync / completion flows with
 * stubbed models. The foundation's pure helpers (HMAC, payload, package
 * extraction) get extra fixture-based cases here. No DB, no network.
 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { t, group, done } = require('./contractHarness')(__filename);

const env = require('../../config/env');
const signers = require('../contracts/signers');
const docusign = require('../contracts/docusign');
const envelopeSync = require('../contracts/envelopeSync');
const eventLogger = require('../contracts/eventLogger');
const portalTokens = require('../contracts/portalTokens');
const emails = require('../contracts/emails');
const AlarmContract = require('../../models/AlarmContract');
const ContractDocument = require('../../models/ContractDocument');
const Setting = require('../../models/Setting');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'docusign', name), 'utf8'));

// ---------------------------------------------------------------------------
// Stub helpers: every stub is undone after its test, so the other contract
// test files (same process) see the real modules.
// ---------------------------------------------------------------------------
const originals = [];
function stub(obj, key, fn) {
  originals.push([obj, key, Object.prototype.hasOwnProperty.call(obj, key), obj[key]]);
  obj[key] = fn;
}
function restoreAll() {
  while (originals.length) {
    const [obj, key, had, val] = originals.pop();
    if (had) obj[key] = val;
    else delete obj[key];
  }
}
// A mongoose-query look-alike: chainable and awaitable, .lean() resolves.
function q(value) {
  const p = Promise.resolve(value);
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: () => p,
    then: (a, b) => p.then(a, b),
  };
  return chain;
}
async function withStubs(fn) {
  try {
    await fn();
  } finally {
    restoreAll();
    docusign.__setHttp(null);
  }
}

const P = (name, email, extra = {}) => ({ role: 'buyer', name, email, signs: true, ...extra });

// ===========================================================================
group('buildSigners');

t('one buyer → recipient 1 owns the package group, remote has no clientUserId', () => {
  const s = signers.buildSigners([P('Jane Doe', 'Jane@Example.com')]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].recipientId, '1');
  assert.strictEqual(s[0].routingOrder, 1);
  assert.strictEqual(s[0].email, 'jane@example.com');
  assert.strictEqual(s[0].ownsPackage, true);
  assert.strictEqual(s[0].clientUserId, null);
  assert.deepStrictEqual(s[0].anchors, { signHere: '\\gsig1\\', fullName: '\\gnam1\\', dateSigned: '\\gdat1\\' });
});

t('three buyers → sequential routing 1..3, only the first owns the package', () => {
  const s = signers.buildSigners([P('A', 'a@x.com'), P('B', 'b@x.com', { role: 'coBuyer' }), P('C', 'c@x.com', { role: 'thirdBuyer' })]);
  assert.deepStrictEqual(s.map((x) => x.routingOrder), [1, 2, 3]);
  assert.deepStrictEqual(s.map((x) => x.recipientId), ['1', '2', '3']);
  assert.deepStrictEqual(s.map((x) => x.ownsPackage), [true, false, false]);
  assert.strictEqual(s[2].anchors.signHere, '\\gsig3\\');
  assert.strictEqual(s[2].role, 'thirdBuyer');
});

t('a couple sharing one inbox both sign; the same person twice is deduped', () => {
  const s = signers.buildSigners([
    P('Esmat Shafiee', 'home@x.com'),
    P('Orang Cheshmehkhezr', 'HOME@x.com'),
    P('  esmat   shafiee ', 'home@x.com'),
  ]);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(s.map((x) => x.name), ['Esmat Shafiee', 'Orang Cheshmehkhezr']);
  assert.strictEqual(s[1].email, 'home@x.com');
});

t('primary buyer without an email → the next buyer becomes recipient 1', () => {
  const s = signers.buildSigners([P('No Email', ''), P('Second', 'second@x.com')]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].recipientId, '1');
  assert.strictEqual(s[0].purchaserIndex, 1);
  assert.strictEqual(s[0].ownsPackage, true);
});

t('opted-out (marketing) buyers still sign; signs:false buyers do not', () => {
  const s = signers.buildSigners([P('A', 'a@x.com', { optedOut: true }), P('B', 'b@x.com', { signs: false })]);
  assert.deepStrictEqual(s.map((x) => x.name), ['A']);
});

t('in_person → clientUserId "<contractId>-<n>"', () => {
  const s = signers.buildSigners([P('A', 'a@x.com'), P('B', 'b@x.com')], { mode: 'in_person', contractId: 'c123' });
  assert.deepStrictEqual(s.map((x) => x.clientUserId), ['c123-1', 'c123-2']);
});

t('nobody can sign → no_signer_email', () => {
  for (const list of [[], [P('A', '')], [P('A', 'not-an-email')], [P('A', 'a@x.com', { signs: false })], null]) {
    assert.throws(() => signers.buildSigners(list), (e) => e.code === 'no_signer_email' && e.status === 400);
  }
});

t('signerKey: case and whitespace insensitive', () => {
  assert.strictEqual(signers.signerKey({ email: ' A@X.com ', name: 'Jane  DOE' }), 'a@x.com|jane doe');
});

// ===========================================================================
group('buildEventNotification / buildEnvelopeDefinition');

const contract = {
  _id: '6560a0000000000000000001',
  number: 'GA-2026-00006',
  property: { projectName: 'SERENO BUILDING CORP', lotNumber: '0006' },
};

t('eventNotification is JSON SIM with includeData inside eventData and no legacy arrays', () => {
  const n = docusign.buildEventNotification('https://app.example.com/api/webhooks/docusign');
  assert.strictEqual(n.url, 'https://app.example.com/api/webhooks/docusign');
  assert.strictEqual(n.deliveryMode, 'SIM');
  assert.strictEqual(n.includeHMAC, 'true');
  assert.strictEqual(n.requireAcknowledgment, 'true');
  assert.deepStrictEqual(n.eventData, { version: 'restv2.1', format: 'json', includeData: ['recipients', 'tabs', 'custom_fields'] });
  assert.ok(n.events.includes('envelope-completed') && n.events.includes('recipient-completed'));
  assert.strictEqual(n.includeData, undefined);
  assert.strictEqual(n.envelopeEvents, undefined);
  assert.strictEqual(n.recipientEvents, undefined);
});

t('default URL is APP_URL + /api/webhooks/docusign', () => {
  assert.strictEqual(docusign.buildEventNotification().url, `${env.appUrl}/api/webhooks/docusign`);
});

function definition(opts = {}) {
  const list = signers.buildSigners([P('Esmat Shafiee', 'home@x.com'), P('Orang Cheshmehkhezr', 'home@x.com')], opts);
  return docusign.buildEnvelopeDefinition({ contract, pdf: Buffer.from('%PDF-1.3 test'), signers: list, ccEmail: opts.cc });
}

t('envelope: sent, one PDF document, contractId custom field, subject ≤ 100', () => {
  const d = definition();
  assert.strictEqual(d.status, 'sent');
  assert.strictEqual(d.documents.length, 1);
  assert.strictEqual(d.documents[0].documentId, '1');
  assert.strictEqual(Buffer.from(d.documents[0].documentBase64, 'base64').toString(), '%PDF-1.3 test');
  assert.strictEqual(d.emailSubject, 'Genius Alarm Monitoring Agreement – Lot 0006, SERENO BUILDING CORP');
  const f = d.customFields.textCustomFields.find((x) => x.name === 'contractId');
  assert.strictEqual(f.value, contract._id);
  assert.strictEqual(f.show, 'false');
  const long = docusign.buildEnvelopeDefinition({
    contract: { ...contract, property: { projectName: 'X'.repeat(200), lotNumber: '1' } },
    pdf: Buffer.alloc(1),
    signers: signers.buildSigners([P('A', 'a@x.com')]),
  });
  assert.ok(long.emailSubject.length <= 100);
});

t('signers: sequential string routing, anchors fail loudly, radio group on recipient 1 only', () => {
  const d = definition();
  const [s1, s2] = d.recipients.signers;
  assert.strictEqual(s1.routingOrder, '1');
  assert.strictEqual(s2.routingOrder, '2');
  assert.strictEqual(s1.email, s2.email); // shared inbox, two signers
  for (const s of [s1, s2]) {
    for (const k of ['signHereTabs', 'fullNameTabs', 'dateSignedTabs']) {
      const tab = s.tabs[k][0];
      assert.strictEqual(tab.anchorIgnoreIfNotPresent, 'false');
      assert.strictEqual(tab.anchorUnits, 'pixels');
      assert.strictEqual(tab.anchorMatchWholeWord, 'true');
      assert.ok('anchorXOffset' in tab && 'anchorYOffset' in tab);
    }
  }
  assert.strictEqual(s1.tabs.signHereTabs[0].anchorString, '\\gsig1\\');
  assert.strictEqual(s2.tabs.dateSignedTabs[0].anchorString, '\\gdat2\\');
  assert.strictEqual(s2.tabs.radioGroupTabs, undefined);
  assert.strictEqual(s1.clientUserId, undefined);

  const g = s1.tabs.radioGroupTabs;
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].groupName, 'monitoringPackage');
  assert.strictEqual(g[0].shared, 'false');
  assert.strictEqual(g[0].required, undefined); // required lives on each radio
  assert.deepStrictEqual(g[0].radios.map((r) => r.value), ['basic', 'smart']);
  for (const r of g[0].radios) {
    assert.strictEqual(r.required, 'true');
    assert.strictEqual(r.anchorIgnoreIfNotPresent, 'false');
    assert.strictEqual(r.anchorUnits, 'pixels');
    assert.strictEqual(r.selected, undefined); // nothing preselected
  }
  assert.deepStrictEqual(g[0].radios.map((r) => r.anchorString), ['\\gpkb\\', '\\gpks\\']);
});

t('in_person signers carry clientUserId', () => {
  const d = definition({ mode: 'in_person', contractId: contract._id });
  assert.deepStrictEqual(d.recipients.signers.map((s) => s.clientUserId), [`${contract._id}-1`, `${contract._id}-2`]);
});

t('ccEmail → one carbon copy routed last; none without it', () => {
  const d = definition({ cc: 'Contracts@Example.com' });
  assert.deepStrictEqual(d.recipients.carbonCopies, [
    { email: 'contracts@example.com', name: 'Genius Contracts', recipientId: '100', routingOrder: '3' },
  ]);
  assert.deepStrictEqual(definition().recipients.carbonCopies, []);
});

t('eventNotification only when Connect is enabled', async () => {
  const was = env.docusign.connectEnabled;
  try {
    env.docusign.connectEnabled = false;
    assert.strictEqual(definition().eventNotification, undefined);
    env.docusign.connectEnabled = true;
    assert.strictEqual(definition().eventNotification.deliveryMode, 'SIM');
  } finally {
    env.docusign.connectEnabled = was;
  }
});

// ===========================================================================
group('REST client (fake transport)');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Configure env.docusign for one test; restored by withStubs via stub().
function configure(extra = {}) {
  const d = env.docusign;
  const set = {
    configured: true,
    dispatchable: true,
    integrationKey: 'ik-1',
    userId: 'user-0000',
    accountId: '',
    privateKey,
    authHost: 'account-d.docusign.com',
    consentUrl: 'https://account-d.docusign.com/oauth/auth?client_id=ik-1',
    ...extra,
  };
  for (const [k, v] of Object.entries(set)) stub(d, k, v);
}

// A tiny router over (method url) → handler(config). Records every call.
function fakeHttp(routes) {
  const calls = [];
  const fn = async (config) => {
    calls.push(config);
    const key = `${config.method.toUpperCase()} ${config.url}`;
    const h = routes[key] || Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (!h) throw Object.assign(new Error(`no route ${key}`), { response: { status: 404, data: { errorCode: 'NOT_FOUND' } } });
    return h(config, calls);
  };
  docusign.__setHttp(fn);
  return calls;
}
const ok = (data) => async () => ({ status: 200, data });
const fail = (status, data) => async () => {
  const e = new Error(`Request failed with status code ${status}`);
  e.isAxiosError = true;
  e.code = 'ERR_BAD_REQUEST';
  e.status = status;
  e.response = { status, data };
  throw e;
};
const TOKEN = 'POST https://account-d.docusign.com/oauth/token';
const USERINFO = 'GET https://account-d.docusign.com/oauth/userinfo';
const BASE = 'https://ca.docusign.net/restapi/v2.1/accounts/acc-0000';

t('not configured → not_configured, verifyDocusign never throws', async () => {
  await withStubs(async () => {
    stub(env.docusign, 'configured', false);
    await assert.rejects(docusign.getAccessToken(), (e) => e.code === 'not_configured' && e.status === 503);
    await assert.rejects(docusign.getEnvelope('x'), (e) => e.code === 'not_configured');
    const v = await docusign.verifyDocusign();
    assert.strictEqual(v.ok, false);
  });
});

t('JWT grant: RS256 assertion with iss/sub/aud/scope; token cached across calls', async () => {
  await withStubs(async () => {
    configure();
    const calls = fakeHttp({
      [TOKEN]: async (config) => {
        const assertion = new URLSearchParams(config.data).get('assertion');
        const claims = jwt.verify(assertion, publicKey, { algorithms: ['RS256'] });
        assert.strictEqual(claims.iss, 'ik-1');
        assert.strictEqual(claims.sub, 'user-0000');
        assert.strictEqual(claims.aud, 'account-d.docusign.com');
        assert.strictEqual(claims.scope, 'signature impersonation');
        assert.strictEqual(new URLSearchParams(config.data).get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        return { data: { access_token: 'tok-1', expires_in: 3600 } };
      },
      [USERINFO]: ok(fixture('userinfo.json')),
      [`GET ${BASE}/envelopes/env-0001`]: ok(fixture('envelope-completed.json')),
    });
    const [a, b] = await Promise.all([docusign.getAccessToken(), docusign.getAccessToken()]);
    assert.strictEqual(a, 'tok-1');
    assert.strictEqual(b, 'tok-1');
    await docusign.getEnvelope('env-0001');
    await docusign.getEnvelope('env-0001');
    assert.strictEqual(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1);
    assert.strictEqual(calls.filter((c) => c.url.endsWith('/oauth/userinfo')).length, 1);
    const api = calls.find((c) => c.url.startsWith(BASE));
    assert.strictEqual(api.headers.Authorization, 'Bearer tok-1');
  });
});

t('userinfo: default account and its regional base_uri; DOCUSIGN_ACCOUNT_ID honoured or rejected', async () => {
  await withStubs(async () => {
    configure();
    fakeHttp({ [TOKEN]: ok({ access_token: 't', expires_in: 3600 }), [USERINFO]: ok(fixture('userinfo.json')) });
    const a = await docusign.getAccount();
    assert.deepStrictEqual(a, {
      accountId: 'acc-0000',
      accountName: 'Genius Smart Home',
      baseUri: 'https://ca.docusign.net',
      basePath: BASE,
    });
  });
  await withStubs(async () => {
    configure({ accountId: 'acc-other' });
    fakeHttp({ [TOKEN]: ok({ access_token: 't', expires_in: 3600 }), [USERINFO]: ok(fixture('userinfo.json')) });
    assert.strictEqual((await docusign.getAccount()).baseUri, 'https://na3.docusign.net');
  });
  await withStubs(async () => {
    configure({ accountId: 'acc-missing' });
    fakeHttp({ [TOKEN]: ok({ access_token: 't', expires_in: 3600 }), [USERINFO]: ok(fixture('userinfo.json')) });
    await assert.rejects(docusign.getAccount(), (e) => e.code === 'docusign_auth_failed');
  });
});

t('consent_required → docusign_consent_required with consentUrl; verifyDocusign reports it', async () => {
  await withStubs(async () => {
    configure();
    fakeHttp({ [TOKEN]: fail(400, { error: 'consent_required' }) });
    await assert.rejects(
      docusign.getAccessToken(),
      (e) => e.code === 'docusign_consent_required' && e.consentUrl === env.docusign.consentUrl && e.status === 409
    );
    const v = await docusign.verifyDocusign();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.consentUrl, env.docusign.consentUrl);
  });
});

t('other grant failures → docusign_auth_failed without leaking the key', async () => {
  await withStubs(async () => {
    configure();
    fakeHttp({ [TOKEN]: fail(400, { error: 'invalid_grant', error_description: 'no_valid_keys_or_signatures' }) });
    await assert.rejects(docusign.getAccessToken(), (e) => e.code === 'docusign_auth_failed' && /invalid_grant/.test(e.message));
  });
  await withStubs(async () => {
    configure({ privateKey: 'not a pem' });
    fakeHttp({});
    await assert.rejects(
      docusign.getAccessToken(),
      (e) => e.code === 'docusign_auth_failed' && !e.message.includes('not a pem')
    );
  });
});

t('verifyDocusign ok → account name and base URI', async () => {
  await withStubs(async () => {
    configure();
    fakeHttp({ [TOKEN]: ok({ access_token: 't', expires_in: 3600 }), [USERINFO]: ok(fixture('userinfo.json')) });
    const v = await docusign.verifyDocusign();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.accountId, 'acc-0000');
    assert.ok(v.message.includes('Genius Smart Home'));
  });
});

t('a 401 on an API call refreshes the token once', async () => {
  await withStubs(async () => {
    configure();
    let n = 0;
    let first = true;
    const calls = fakeHttp({
      [TOKEN]: async () => ({ data: { access_token: `tok-${++n}`, expires_in: 3600 } }),
      [USERINFO]: ok(fixture('userinfo.json')),
      [`GET ${BASE}/envelopes/env-0001`]: async (config) => {
        if (first) {
          first = false;
          return fail(401, { errorCode: 'AUTHORIZATION_INVALID_TOKEN' })();
        }
        assert.strictEqual(config.headers.Authorization, 'Bearer tok-2');
        return { data: { status: 'sent' } };
      },
    });
    const e = await docusign.getEnvelope('env-0001');
    assert.strictEqual(e.status, 'sent');
    assert.strictEqual(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 2);
  });
});

function apiRoutes(extra) {
  return { [TOKEN]: ok({ access_token: 't', expires_in: 3600 }), [USERINFO]: ok(fixture('userinfo.json')), ...extra };
}

t('createEnvelope posts the definition; anchor errors → anchor_missing; others → envelope_failed', async () => {
  const list = signers.buildSigners([P('A', 'a@x.com')]);
  await withStubs(async () => {
    configure();
    const calls = fakeHttp(
      apiRoutes({ [`POST ${BASE}/envelopes`]: ok({ envelopeId: 'env-9', status: 'sent', statusDateTime: '2026-11-01T14:00:00Z' }) })
    );
    const r = await docusign.createEnvelope({ contract, pdf: Buffer.from('%PDF'), signers: list });
    assert.deepStrictEqual(r, { envelopeId: 'env-9', status: 'sent', statusDateTime: '2026-11-01T14:00:00Z' });
    const post = calls.find((c) => c.method === 'post' && c.url === `${BASE}/envelopes`);
    assert.strictEqual(post.data.status, 'sent');
    assert.strictEqual(post.data.recipients.signers[0].tabs.radioGroupTabs[0].groupName, 'monitoringPackage');
  });
  await withStubs(async () => {
    configure();
    fakeHttp(apiRoutes({ [`POST ${BASE}/envelopes`]: fail(400, { errorCode: 'ANCHOR_TAB_STRING_NOT_FOUND', message: 'x' }) }));
    await assert.rejects(docusign.createEnvelope({ contract, pdf: Buffer.from('%PDF'), signers: list }), (e) => e.code === 'anchor_missing');
  });
  await withStubs(async () => {
    configure();
    fakeHttp(apiRoutes({ [`POST ${BASE}/envelopes`]: fail(400, { errorCode: 'INVALID_EMAIL_ADDRESS_FOR_RECIPIENT', message: 'bad' }) }));
    await assert.rejects(
      docusign.createEnvelope({ contract, pdf: Buffer.from('%PDF'), signers: list }),
      (e) => e.code === 'envelope_failed' && /INVALID_EMAIL/.test(e.message)
    );
  });
});

t('recipients include tabs; form data; documents as Buffers with certificate=false on combined', async () => {
  await withStubs(async () => {
    configure();
    const calls = fakeHttp(
      apiRoutes({
        [`GET ${BASE}/envelopes/env-0001/recipients`]: ok(fixture('recipients-completed-smart.json')),
        [`GET ${BASE}/envelopes/env-0001/form_data`]: ok(fixture('form-data-basic.json')),
        [`GET ${BASE}/envelopes/env-0001/documents/combined`]: async () => ({ data: Buffer.from('%PDF-signed').buffer }),
        [`GET ${BASE}/envelopes/env-0001/documents/certificate`]: async () => ({ data: Buffer.from('%PDF-cert') }),
      })
    );
    const r = await docusign.getRecipientsWithTabs('env-0001');
    assert.strictEqual(r.signers.length, 2);
    assert.strictEqual(r.carbonCopies.length, 1);
    assert.strictEqual(calls.at(-1).params.include_tabs, 'true');
    const f = await docusign.getFormData('env-0001');
    assert.strictEqual(f.recipientFormData[0].formData[0].value, 'basic');
    const combined = await docusign.downloadCombined('env-0001');
    assert.ok(Buffer.isBuffer(combined));
    assert.strictEqual(calls.at(-1).params.certificate, 'false');
    assert.strictEqual(calls.at(-1).responseType, 'arraybuffer');
    const cert = await docusign.downloadCertificate('env-0001');
    assert.strictEqual(cert.toString(), '%PDF-cert');
  });
});

t('listStatusChanges batches 100 ids per call and normalises status', async () => {
  await withStubs(async () => {
    configure();
    const ids = Array.from({ length: 150 }, (_, i) => `env-${i}`);
    const calls = fakeHttp(
      apiRoutes({
        [`GET ${BASE}/envelopes`]: async (config) => ({
          data: {
            envelopes: config.params.envelope_ids
              .split(',')
              .slice(0, 1)
              .map((id) => ({ envelopeId: id, status: 'Completed', statusChangedDateTime: '2026-11-03T00:00:00Z' })),
          },
        }),
      })
    );
    const from = new Date('2026-10-01T00:00:00Z');
    const r = await docusign.listStatusChanges({ envelopeIds: [...ids, 'env-0'], fromDate: from });
    const list = calls.filter((c) => c.url === `${BASE}/envelopes`);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].params.envelope_ids.split(',').length, 100);
    assert.strictEqual(list[1].params.envelope_ids.split(',').length, 50);
    assert.strictEqual(list[0].params.from_date, from.toISOString());
    assert.deepStrictEqual(r.map((x) => x.status), ['completed', 'completed']);
    assert.deepStrictEqual(await docusign.listStatusChanges({ envelopeIds: [] }), []);
  });
});

t('void, resend (only unfinished signers) and the recipient view', async () => {
  await withStubs(async () => {
    configure();
    const calls = fakeHttp(
      apiRoutes({
        [`PUT ${BASE}/envelopes/env-0001`]: ok({}),
        [`GET ${BASE}/envelopes/env-0001/recipients`]: ok(fixture('recipients-delivered.json')),
        [`PUT ${BASE}/envelopes/env-0001/recipients`]: ok({}),
        [`POST ${BASE}/envelopes/env-0001/views/recipient`]: ok({ url: 'https://demo.docusign.net/Signing/x' }),
      })
    );
    await docusign.voidEnvelope('env-0001', 'Wrong lot');
    assert.deepStrictEqual(calls.at(-1).data, { status: 'voided', voidedReason: 'Wrong lot' });
    await docusign.resendEnvelope('env-0001');
    const put = calls.at(-1);
    assert.strictEqual(put.params.resend_envelope, 'true');
    assert.deepStrictEqual(put.data.signers.map((s) => s.recipientId), ['2']);
    const v = await docusign.createRecipientView('env-0001', {
      recipientId: '1',
      name: 'Esmat Shafiee',
      email: 'esmat@example.com',
      clientUserId: 'c-1',
      returnUrl: 'https://app/contracts/c/signing-return',
    });
    assert.strictEqual(v.url, 'https://demo.docusign.net/Signing/x');
    assert.strictEqual(calls.at(-1).data.authenticationMethod, 'none');
    assert.strictEqual(calls.at(-1).data.userName, 'Esmat Shafiee');
  });
});

t('recipient view out of sequence → not_your_turn', async () => {
  await withStubs(async () => {
    configure();
    fakeHttp(apiRoutes({ [`POST ${BASE}/envelopes/env-0001/views/recipient`]: fail(400, { errorCode: 'RECIPIENT_NOT_IN_SEQUENCE' }) }));
    await assert.rejects(
      docusign.createRecipientView('env-0001', { recipientId: '2', name: 'B', email: 'b@x.com', clientUserId: 'c-2', returnUrl: 'x' }),
      (e) => e.code === 'not_your_turn'
    );
  });
});

// ===========================================================================
group('Connect helpers with fixtures');

t('real-shaped Connect payload: HMAC over the raw bytes, stable eventId', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'docusign', 'connect-envelope-completed.json'));
  const sig = crypto.createHmac('sha256', 'secret-2').update(raw).digest('base64');
  const v = docusign.verifyConnectHmac({ rawBody: raw, headers: { 'X-DocuSign-Signature-1': sig }, keys: ['secret-1', 'secret-2'] });
  assert.deepStrictEqual(v, { ok: true, keyIndex: 1, header: 'X-DocuSign-Signature-1' });
  // A re-serialised body (different whitespace) must not verify.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
  assert.strictEqual(docusign.verifyConnectHmac({ rawBody: reserialised, headers: { 'X-DocuSign-Signature-1': sig }, keys: ['secret-2'] }).ok, false);
  const n = docusign.normaliseConnectPayload(JSON.parse(raw.toString()));
  assert.strictEqual(n.envelopeId, 'env-0001');
  assert.strictEqual(n.contractId, '6560a0000000000000000001');
  assert.strictEqual(n.status, 'completed');
  assert.strictEqual(n.eventId, docusign.normaliseConnectPayload(JSON.parse(raw.toString())).eventId);
});

t('extractPackageChoice on recipient fixtures', () => {
  assert.strictEqual(docusign.extractPackageChoice({ recipients: fixture('recipients-completed-smart.json') }).package, 'smart');
  const none = docusign.extractPackageChoice({ recipients: fixture('recipients-completed-none.json') });
  assert.deepStrictEqual(none, { package: null, source: null, raw: null });
  const fb = docusign.extractPackageChoice({
    recipients: fixture('recipients-completed-none.json'),
    formData: fixture('form-data-basic.json'),
  });
  assert.deepStrictEqual(fb, { package: 'basic', source: 'form_data', raw: 'basic' });
});

// ===========================================================================
group('planEnvelopeSync (pure)');

const sentContract = () => ({
  _id: 'c1',
  number: 'GA-2026-00006',
  lot: 'l1',
  project: 'p1',
  status: 'sent',
  signedAt: null,
  envelope: { id: 'env-0001', status: 'sent', sentAt: new Date('2026-11-01T14:00:00Z') },
  purchasers: [
    { name: 'Esmat Shafiee', email: 'esmat@example.com', recipientId: '1', signStatus: 'sent' },
    { name: 'Orang Cheshmehkhezr', email: 'esmat@example.com', recipientId: '2', signStatus: 'created' },
  ],
});

t('completed: advances, stamps completedAt + signedAt, both signers signed', () => {
  const p = envelopeSync.planEnvelopeSync(sentContract(), fixture('envelope-completed.json'), fixture('recipients-completed-smart.json'));
  assert.strictEqual(p.to, 'completed');
  assert.strictEqual(p.advance, true);
  assert.strictEqual(p.envelopeSet['envelope.status'], 'completed');
  assert.strictEqual(p.envelopeSet['envelope.completedAt'].toISOString(), '2026-11-03T15:04:00.000Z');
  assert.strictEqual(p.envelopeSet.signedAt.toISOString(), '2026-11-03T15:04:00.000Z');
  assert.strictEqual(p.envelopeSet['envelope.sentAt'], undefined); // already known
  assert.strictEqual(p.purchaserSet['purchasers.0.signStatus'], 'completed');
  assert.strictEqual(p.purchaserSet['purchasers.1.signStatus'], 'completed');
  assert.strictEqual(p.purchaserSet['purchasers.1.signedAt'].toISOString(), '2026-11-03T15:04:00.000Z');
  assert.deepStrictEqual(p.signerEvents.map((e) => e.index), [0, 1]);
});

t('never moves backwards: a stale "sent" read after completion changes nothing', () => {
  const c = sentContract();
  c.envelope.status = 'completed';
  c.purchasers.forEach((p) => {
    p.signStatus = 'completed';
  });
  const p = envelopeSync.planEnvelopeSync(c, { status: 'sent' }, fixture('recipients-delivered.json'));
  assert.strictEqual(p.advance, false);
  assert.deepStrictEqual(p.envelopeSet, {});
  assert.strictEqual(p.purchaserSet['purchasers.1.signStatus'], undefined);
  assert.deepStrictEqual(p.signerEvents, []);
});

t('declined: reason from the declining recipient; unknown statuses ignored', () => {
  const p = envelopeSync.planEnvelopeSync(
    sentContract(),
    { status: 'declined', declinedDateTime: '2026-11-02T10:00:00Z' },
    { signers: [{ recipientId: '1', status: 'declined', declinedReason: 'Wrong address' }] }
  );
  assert.strictEqual(p.envelopeSet['envelope.status'], 'declined');
  assert.strictEqual(p.envelopeSet['envelope.declinedReason'], 'Wrong address');
  assert.strictEqual(p.purchaserSet['purchasers.0.declinedReason'], 'Wrong address');
  const odd = envelopeSync.planEnvelopeSync(sentContract(), { status: 'processing' }, { signers: [] });
  assert.strictEqual(odd.to, null);
  assert.strictEqual(odd.advance, false);
});

t('signers matched by email+name when recipientId is missing', () => {
  const c = sentContract();
  c.purchasers.forEach((p) => {
    p.recipientId = '';
  });
  const p = envelopeSync.planEnvelopeSync(c, { status: 'delivered' }, fixture('recipients-delivered.json'));
  assert.strictEqual(p.purchaserSet['purchasers.0.signStatus'], 'completed');
  assert.strictEqual(p.purchaserSet['purchasers.1.signStatus'], 'sent');
});

// ===========================================================================
group('applyEnvelopeStatus / completeEnvelope (stubbed models)');

// Shared stub set for the flow tests. Returns the recorded calls.
function flowStubs({ contract: c, recipients = fixture('recipients-completed-smart.json'), claim = true }) {
  const rec = { updates: [], events: [], alerts: [], docs: [], invites: [], upserts: [] };
  stub(AlarmContract, 'findOne', () => q(c));
  stub(AlarmContract, 'findById', () => q({ ...c, envelope: { ...c.envelope, status: 'completed' } }));
  stub(AlarmContract, 'findOneAndUpdate', (filter, update) => {
    rec.updates.push({ filter, update, op: 'findOneAndUpdate' });
    return q(claim ? { ...c, envelope: { ...c.envelope, status: 'completed' } } : null);
  });
  stub(AlarmContract, 'updateOne', async (filter, update) => {
    rec.updates.push({ filter, update, op: 'updateOne' });
    return { modifiedCount: 1 };
  });
  stub(AlarmContract, 'refreshStatus', async () => ({ from: 'sent', to: 'awaiting_payment', changed: true }));
  stub(ContractDocument, 'findOneAndUpdate', (filter, update) => {
    rec.docs.push({ filter, update });
    return q({ _id: `doc-${filter.kind}`, sha256: update.$set.sha256, size: update.$set.size });
  });
  stub(eventLogger, 'logContractEvent', async (ev) => {
    rec.events.push(ev);
    return {};
  });
  stub(emails, 'sendAdminAlert', async (a) => {
    rec.alerts.push(a);
    return { ok: true };
  });
  stub(portalTokens, 'upsertPortalUsersForContract', async (x) => {
    rec.upserts.push(x);
    return [];
  });
  stub(portalTokens, 'inviteContractUsers', async (x, o) => {
    rec.invites.push({ x, o });
    return { sent: 1, results: [] };
  });
  stub(docusign, 'getEnvelope', async () => fixture('envelope-completed.json'));
  stub(docusign, 'getRecipientsWithTabs', async () => recipients);
  stub(docusign, 'getFormData', async () => ({ formData: [], recipientFormData: [] }));
  stub(docusign, 'downloadCombined', async () => Buffer.from('%PDF-signed'));
  stub(docusign, 'downloadCertificate', async () => Buffer.from('%PDF-certificate'));
  return rec;
}

t('unknown envelope → ignored (Connect still gets a 200)', async () => {
  await withStubs(async () => {
    stub(AlarmContract, 'findOne', () => q(null));
    stub(docusign, 'getEnvelope', async () => {
      throw new Error('must not be called');
    });
    assert.deepStrictEqual(await envelopeSync.applyEnvelopeStatus('env-x', { actor: 'docusign' }), {
      ok: true,
      ignored: 'unknown_envelope',
    });
  });
});

t('completed envelope: CAS write, signer events, package smart, documents with sha256, portal users + welcome, milestone once', async () => {
  await withStubs(async () => {
    const rec = flowStubs({ contract: sentContract() });
    const r = await envelopeSync.applyEnvelopeStatus('env-0001', { actor: 'docusign' });
    assert.deepStrictEqual(r, {
      ok: true,
      contractId: 'c1',
      envelopeStatus: 'completed',
      status: 'awaiting_payment',
      changed: true,
      completed: true,
    });
    const cas = rec.updates.find((u) => u.update.$set && u.update.$set['envelope.status'] === 'completed');
    assert.deepStrictEqual(cas.filter['envelope.status'], { $in: [null, 'created', 'sent', 'delivered'] });
    const claim = rec.updates.find((u) => u.op === 'findOneAndUpdate');
    assert.strictEqual(claim.filter['envelope.completionDoneAt'], null);
    assert.ok(claim.update.$set['envelope.completionClaimedAt'] instanceof Date);
    const pkg = rec.updates.find((u) => u.update.$set && u.update.$set.package);
    assert.strictEqual(pkg.update.$set.package, 'smart');
    assert.strictEqual(pkg.update.$set.pricing.totalCents, 3728);
    assert.strictEqual(pkg.update.$set.packageSource, 'docusign');
    assert.deepStrictEqual(rec.docs.map((d) => d.filter.kind), ['agreement_signed', 'certificate']);
    const signed = rec.docs[0].update.$set;
    assert.strictEqual(signed.sha256, crypto.createHash('sha256').update('%PDF-signed').digest('hex'));
    assert.strictEqual(rec.docs[0].filter.singleton, true);
    assert.strictEqual(rec.upserts.length, 1);
    assert.strictEqual(rec.invites.length, 1);
    const done = rec.updates.find((u) => u.update.$set && u.update.$set['envelope.completionDoneAt']);
    assert.strictEqual(done.filter['envelope.completionDoneAt'], null);
    const types = rec.events.map((e) => e.type);
    assert.deepStrictEqual(types.filter((x) => x === 'completed'), ['completed']);
    assert.strictEqual(types.filter((x) => x === 'recipient_signed').length, 2);
    assert.ok(types.includes('documents_stored'));
    assert.ok(rec.events.find((e) => e.type === 'completed').message.includes('Smart Monitoring'));
    assert.deepStrictEqual(rec.alerts, []);
  });
});

t('no package chosen → package_missing + admin alert, no welcome email', async () => {
  await withStubs(async () => {
    const rec = flowStubs({ contract: sentContract(), recipients: fixture('recipients-completed-none.json') });
    const r = await envelopeSync.completeEnvelope('c1', { actor: 'docusign_poller' });
    assert.deepStrictEqual(r, { done: true, package: null, needsAttention: 'package_missing' });
    assert.ok(rec.updates.some((u) => u.update.$set && u.update.$set.needsAttention === 'package_missing'));
    assert.strictEqual(rec.alerts.length, 1);
    assert.strictEqual(rec.alerts[0].alertKind, 'package_missing');
    assert.strictEqual(rec.invites.length, 0);
    assert.strictEqual(rec.upserts.length, 1);
    assert.ok(rec.events.some((e) => e.type === 'package_missing'));
  });
});

t('completion already claimed / already done → skipped, nothing downloaded', async () => {
  await withStubs(async () => {
    const rec = flowStubs({ contract: sentContract(), claim: false });
    stub(AlarmContract, 'findById', () => q({ envelope: { status: 'completed', completionDoneAt: new Date() } }));
    assert.deepStrictEqual(await envelopeSync.completeEnvelope('c1'), { done: false, skipped: 'already_done' });
    assert.strictEqual(rec.docs.length, 0);
  });
  await withStubs(async () => {
    flowStubs({ contract: sentContract(), claim: false });
    stub(AlarmContract, 'findById', () => q({ envelope: { status: 'completed', completionDoneAt: null } }));
    assert.deepStrictEqual(await envelopeSync.completeEnvelope('c1'), { done: false, skipped: 'claimed' });
  });
});

t('a failing step releases the claim and rethrows (poller / Connect retry)', async () => {
  await withStubs(async () => {
    const rec = flowStubs({ contract: sentContract() });
    stub(docusign, 'downloadCertificate', async () => {
      throw Object.assign(new Error('DocuSign certificate download failed'), { code: 'envelope_failed' });
    });
    await assert.rejects(envelopeSync.completeEnvelope('c1'), (e) => e.code === 'envelope_failed');
    const release = rec.updates.at(-1);
    assert.strictEqual(release.update.$set['envelope.completionClaimedAt'], null);
    assert.ok(release.filter['envelope.completionClaimedAt'] instanceof Date);
    assert.ok(!rec.updates.some((u) => u.update.$set && u.update.$set['envelope.completionDoneAt']));
  });
});

t('declined envelope → declined event + admin alert, no completion', async () => {
  await withStubs(async () => {
    const rec = flowStubs({
      contract: sentContract(),
      recipients: { signers: [{ recipientId: '1', status: 'declined', declinedReason: 'Not buying monitoring' }] },
    });
    stub(docusign, 'getEnvelope', async () => ({ status: 'declined', declinedDateTime: '2026-11-02T10:00:00Z' }));
    stub(AlarmContract, 'refreshStatus', async () => ({ from: 'sent', to: 'declined', changed: true }));
    const r = await envelopeSync.applyEnvelopeStatus('env-0001', { actor: 'docusign' });
    assert.strictEqual(r.envelopeStatus, 'declined');
    assert.strictEqual(r.completed, false);
    assert.deepStrictEqual(rec.events.map((e) => e.type), ['declined']);
    assert.ok(rec.events[0].message.includes('Not buying monitoring'));
    assert.strictEqual(rec.alerts[0].alertKind, 'declined');
  });
});

t('a duplicate delivery that loses the CAS logs nothing', async () => {
  await withStubs(async () => {
    const c = sentContract();
    c.envelope.status = 'delivered';
    const rec = flowStubs({ contract: c, recipients: fixture('recipients-delivered.json') });
    stub(docusign, 'getEnvelope', async () => ({ status: 'delivered' }));
    stub(AlarmContract, 'updateOne', async (filter, update) => {
      rec.updates.push({ filter, update });
      return { modifiedCount: 0 };
    });
    c.purchasers[0].signStatus = 'completed';
    c.purchasers[1].signStatus = 'sent';
    const r = await envelopeSync.applyEnvelopeStatus('env-0001');
    assert.strictEqual(r.changed, false);
    assert.deepStrictEqual(rec.events, []);
  });
});

group('send / paper / set package guards');

t('paper upload validates package, PDF magic and size before touching the DB', async () => {
  await withStubs(async () => {
    stub(AlarmContract, 'findById', () => {
      throw new Error('must not query');
    });
    const pdf = Buffer.from('%PDF-1.4 signed');
    await assert.rejects(envelopeSync.completePaperSigning('c1', { pdf, package: 'gold' }), (e) => e.code === 'invalid_package');
    await assert.rejects(
      envelopeSync.completePaperSigning('c1', { pdf: Buffer.from('GIF89a'), package: 'basic' }),
      (e) => e.code === 'invalid_document'
    );
    await assert.rejects(
      envelopeSync.completePaperSigning('c1', { pdf: Buffer.alloc(ContractDocument.MAX_BYTES + 1, 0x25), package: 'basic' }),
      (e) => e.code === 'document_too_large'
    );
    await assert.rejects(
      envelopeSync.completePaperSigning('c1', { pdf, package: 'basic', signedAt: 'not a date' }),
      (e) => e.code === 'validation_failed'
    );
  });
});

t('paper upload on a draft: stores the upload, completes the mirror, runs the tail', async () => {
  await withStubs(async () => {
    const draft = { ...sentContract(), status: 'draft', signingMode: 'remote', envelope: { status: null } };
    const rec = flowStubs({ contract: draft });
    // Claims return the contract as it is after the paper update.
    stub(AlarmContract, 'findOneAndUpdate', (filter, update) => {
      rec.updates.push({ filter, update, op: 'findOneAndUpdate' });
      return q({ ...draft, signingMode: 'paper', package: 'basic', envelope: { status: 'completed' } });
    });
    let reads = 0;
    stub(AlarmContract, 'findById', () => {
      reads += 1;
      // 1st read: the guard (draft); later reads: after the update.
      if (reads === 1) return q(draft);
      return q({ ...draft, signingMode: 'paper', status: 'awaiting_payment', package: 'basic', envelope: { status: 'completed' } });
    });
    const out = await envelopeSync.completeManualSigned(draft, {
      pdfBuffer: Buffer.from('%PDF-1.4 paper'),
      package: 'basic',
      signedAt: '2026-10-20',
      note: 'Signed at closing',
      actor: 'mariyam',
    });
    assert.strictEqual(out.status, 'awaiting_payment');
    assert.strictEqual(rec.docs[0].filter.kind, 'agreement_signed');
    assert.strictEqual(rec.docs[0].update.$set.source, 'upload');
    assert.strictEqual(rec.docs[0].update.$set.uploadedBy, 'mariyam');
    const upd = rec.updates.find((u) => u.update.$set && u.update.$set.signingMode === 'paper');
    assert.strictEqual(upd.update.$set['envelope.status'], 'completed');
    assert.strictEqual(upd.update.$set.packageSource, 'paper');
    assert.strictEqual(upd.update.$set.pricing.totalCents, 2824);
    assert.ok(rec.events.some((e) => e.type === 'paper_signed' && e.actorName === 'mariyam'));
    // Paper: no DocuSign downloads and no second "completed" milestone.
    assert.ok(!rec.events.some((e) => e.type === 'completed'));
    assert.strictEqual(rec.docs.length, 1);
    assert.strictEqual(rec.invites.length, 1);
  });
});

t('send refuses non-drafts and an unconfigured DocuSign', async () => {
  await withStubs(async () => {
    stub(AlarmContract, 'findById', () => q({ ...sentContract(), signingMode: 'remote' }));
    await assert.rejects(envelopeSync.sendContract('c1'), (e) => e.code === 'invalid_state');
  });
  await withStubs(async () => {
    stub(AlarmContract, 'findById', () => q({ ...sentContract(), status: 'draft', signingMode: 'remote', envelope: {} }));
    stub(env.docusign, 'dispatchable', false);
    await assert.rejects(envelopeSync.sendContract('c1'), (e) => e.code === 'not_configured');
  });
});

t('send: claim → envelope → mirror + unsigned PDF; DocuSign failure rolls the claim back', async () => {
  const draft = {
    ...sentContract(),
    status: 'draft',
    signingMode: 'remote',
    envelope: { status: null },
    property: { projectName: 'SERENO BUILDING CORP', lotNumber: '0006' },
    purchasers: [P('Esmat Shafiee', 'esmat@example.com'), P('Nobody', '')],
  };
  await withStubs(async () => {
    const rec = flowStubs({ contract: draft });
    stub(AlarmContract, 'findById', () => q(draft));
    stub(env.docusign, 'dispatchable', true);
    stub(Setting, 'getSingleton', async () => ({ alarm: { termsVersion: '2026-11', contractsCcEmail: 'cc@x.com' } }));
    let sent;
    stub(docusign, 'createEnvelope', async (a) => {
      sent = a;
      return { envelopeId: 'env-new', status: 'sent', statusDateTime: '2026-11-01T14:00:00Z' };
    });
    await envelopeSync.sendContract('c1', { user: 'mariyam' });
    assert.strictEqual(sent.ccEmail, 'cc@x.com');
    assert.strictEqual(sent.pdf.subarray(0, 4).toString(), '%PDF');
    assert.strictEqual(sent.signers.length, 1);
    const claim = rec.updates.find((u) => u.op === 'findOneAndUpdate');
    assert.strictEqual(claim.filter.status, 'draft');
    const mirror = rec.updates.find((u) => u.update.$set && u.update.$set['envelope.id'] === 'env-new');
    assert.strictEqual(mirror.update.$set['envelope.status'], 'sent');
    assert.strictEqual(mirror.update.$set['purchasers.0.recipientId'], '1');
    assert.strictEqual(mirror.update.$set['purchasers.1.recipientId'], '');
    assert.strictEqual(mirror.update.$set.termsVersion, '2026-11');
    assert.strictEqual(rec.docs[0].filter.kind, 'agreement_unsigned');
    assert.ok(rec.events.some((e) => e.type === 'sent' && e.actorName === 'mariyam'));
  });
  await withStubs(async () => {
    const rec = flowStubs({ contract: draft });
    stub(AlarmContract, 'findById', () => q(draft));
    stub(env.docusign, 'dispatchable', true);
    stub(Setting, 'getSingleton', async () => ({ alarm: { termsVersion: '2026-11' } }));
    stub(docusign, 'createEnvelope', async () => {
      throw Object.assign(new Error('consent'), { code: 'docusign_consent_required', consentUrl: 'u' });
    });
    await assert.rejects(envelopeSync.sendContract('c1'), (e) => e.code === 'docusign_consent_required');
    const last = rec.updates.at(-1);
    assert.strictEqual(last.update.$set['envelope.sendClaimedAt'], null);
    assert.ok(!rec.updates.some((u) => u.update.$set && u.update.$set['envelope.id']));
  });
  // A create that timed out but went through is adopted, not orphaned.
  await withStubs(async () => {
    const rec = flowStubs({ contract: draft });
    stub(AlarmContract, 'findById', () => q(draft));
    stub(env.docusign, 'dispatchable', true);
    stub(Setting, 'getSingleton', async () => ({ alarm: { termsVersion: '2026-11' } }));
    stub(docusign, 'createEnvelope', async () => {
      throw Object.assign(new Error('timeout'), { code: 'envelope_failed', ambiguous: true });
    });
    let lookedUp;
    stub(docusign, 'findSentEnvelopesForContract', async (a) => {
      lookedUp = a;
      return [{ envelopeId: 'env-late', status: 'sent', statusDateTime: '2026-11-01T14:00:00Z' }];
    });
    await envelopeSync.sendContract('c1', { user: 'mariyam' });
    assert.strictEqual(lookedUp.contractId, String(draft._id));
    const mirror = rec.updates.find((u) => u.update.$set && u.update.$set['envelope.id'] === 'env-late');
    assert.ok(mirror, 'the late envelope is recorded');
    assert.strictEqual(mirror.update.$set['envelope.status'], 'sent');
  });
  // Timed out and really not there: the usual rollback.
  await withStubs(async () => {
    const rec = flowStubs({ contract: draft });
    stub(AlarmContract, 'findById', () => q(draft));
    stub(env.docusign, 'dispatchable', true);
    stub(Setting, 'getSingleton', async () => ({ alarm: { termsVersion: '2026-11' } }));
    stub(docusign, 'createEnvelope', async () => {
      throw Object.assign(new Error('timeout'), { code: 'envelope_failed', ambiguous: true });
    });
    stub(docusign, 'findSentEnvelopesForContract', async () => []);
    await assert.rejects(envelopeSync.sendContract('c1'), (e) => e.code === 'envelope_failed');
    assert.strictEqual(rec.updates.at(-1).update.$set['envelope.sendClaimedAt'], null);
    assert.ok(!rec.updates.some((u) => u.update.$set && u.update.$set['envelope.id']));
  });
});

t('setPackageManually needs a valid package and a note', async () => {
  await withStubs(async () => {
    await assert.rejects(envelopeSync.setPackageManually('c1', { package: 'x', note: 'n' }), (e) => e.code === 'invalid_package');
    await assert.rejects(envelopeSync.setPackageManually('c1', { package: 'smart', note: '  ' }), (e) => e.code === 'validation_failed');
    stub(AlarmContract, 'findById', () => q({ ...sentContract(), status: 'awaiting_payment', needsAttention: '' }));
    await assert.rejects(envelopeSync.setPackageManually('c1', { package: 'smart', note: 'Called the buyer' }), (e) => e.code === 'invalid_state');
  });
});

module.exports = done();

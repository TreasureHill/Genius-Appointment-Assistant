/**
 * The generated agreement PDF (pdfkit): pure agreementData shape, and the
 * rendered file — real PDF, the addendum equipment text, both package lines
 * priced from pricing.js, the terms + version, and the DocuSign anchors
 * (white, 6pt, one text run each) present only for signers that exist.
 * Rendered with compress:false so the content streams can be read. No DB.
 */
const assert = require('assert');
const { t, group, done } = require('./contractHarness')(__filename);
const pdf = require('../contracts/agreementPdf');
const { ANCHORS } = require('../contracts/signers');

const contract = (purchasers) => ({
  _id: '6560a0000000000000000001',
  number: 'GA-2026-00006',
  signingMode: 'remote',
  termsVersion: '',
  property: {
    projectName: 'SERENO BUILDING CORP',
    model: 'A3END A',
    lotNumber: '0006',
    address: '12 Example Street, Vaughan ON',
    closingDate: new Date('2026-11-14T12:00:00Z'),
  },
  purchasers,
});
const two = [
  { role: 'buyer', name: 'Esmat Shafiee', email: 'home@example.com', signs: true },
  { role: 'coBuyer', name: 'Orang Cheshmehkhezr', email: 'home@example.com', signs: true },
];

// Read every text run out of an uncompressed pdfkit file: the hex strings of
// each TJ, decoded (WinAnsi = latin1 plus the dashes we print), with the fill
// colour and font size in force when it was drawn.
const WIN_ANSI = { '\x96': '–', '\x97': '—' };
const decode = (hex) => Buffer.from(hex, 'hex').toString('latin1').replace(/[\x96\x97]/g, (c) => WIN_ANSI[c]);
function textRuns(buf) {
  const runs = [];
  let fill = '';
  let size = 0;
  for (const line of buf.toString('latin1').split('\n')) {
    if (/ scn$/.test(line)) fill = line.replace(/ scn$/, '');
    const tf = line.match(/^\/F\d+ ([\d.]+) Tf$/);
    if (tf) size = Number(tf[1]);
    if (/\] TJ$/.test(line)) {
      const text = [...line.matchAll(/<([0-9a-f]*)>/g)].map((m) => decode(m[1])).join('');
      runs.push({ text, fill, size });
    }
  }
  return runs;
}
const allText = (runs) => runs.map((r) => r.text).join(' ').replace(/\s+/g, ' ');

group('agreementData (pure)');

t('shape: number, property, names, both packages, signers, terms', () => {
  const d = pdf.agreementData(contract(two), { termsVersion: '2026-11', generatedAt: new Date('2026-11-01T12:00:00Z') });
  assert.strictEqual(d.number, 'GA-2026-00006');
  assert.strictEqual(d.termsVersion, '2026-11');
  assert.strictEqual(d.property.model, 'A3END A');
  assert.strictEqual(d.purchaserNames, 'Esmat Shafiee and Orang Cheshmehkhezr');
  assert.deepStrictEqual(d.packages.map((p) => [p.package, p.unitCents, p.taxCents, p.totalCents]), [
    ['basic', 2499, 325, 2824],
    ['smart', 3299, 429, 3728],
  ]);
  assert.strictEqual(d.signers.length, 2);
  assert.deepStrictEqual(d.terms, pdf.TERMS);
  assert.ok(d.generatedAt instanceof Date);
});

t('signers can be passed in; default build throws no_signer_email when nobody can sign', () => {
  const d = pdf.agreementData(contract(two), { signers: [] });
  assert.deepStrictEqual(d.signers, []);
  assert.throws(() => pdf.agreementData(contract([{ name: 'No Email', email: '' }])), (e) => e.code === 'no_signer_email');
});

t('closing dates print in UTC (no day shift)', () => {
  assert.strictEqual(pdf.fmtDate(new Date('2026-11-14T12:00:00Z')), 'November 14, 2026');
  assert.strictEqual(pdf.fmtDate(null), '');
});

group('buildAgreementPdf');

let twoBuf;
let twoRuns;
t('renders a real PDF (compressed and not)', async () => {
  const data = pdf.agreementData(contract(two), { termsVersion: '2026-11' });
  const zipped = await pdf.buildAgreementPdf(data);
  assert.strictEqual(zipped.subarray(0, 4).toString(), '%PDF');
  twoBuf = await pdf.buildAgreementPdf(data, { compress: false });
  assert.strictEqual(twoBuf.subarray(0, 4).toString(), '%PDF');
  assert.ok(twoBuf.toString('latin1').trimEnd().endsWith('%%EOF'));
  twoRuns = textRuns(twoBuf);
  assert.ok(twoRuns.length > 20);
});

t('contents: title, number, property, purchasers, equipment verbatim, $980 not billed', () => {
  const text = allText(twoRuns);
  for (const s of [
    'Alarm Monitoring Agreement',
    'GA-2026-00006',
    'Terms version 2026-11',
    'SERENO BUILDING CORP',
    'A3END A',
    '0006',
    '12 Example Street, Vaughan ON',
    'November 14, 2026',
    'Esmat Shafiee',
    'Orang Cheshmehkhezr',
    '$980.00',
  ]) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
  // pdfkit wraps lines, so compare word streams.
  const words = (s) => s.replace(/\s+/g, ' ').trim();
  assert.ok(words(text).includes(words(pdf.EQUIPMENT_TEXT)), 'equipment text not verbatim');
});

t('package lines carry price + 13% HST = total from pricing.js', () => {
  const text = allText(twoRuns);
  assert.ok(text.includes('Basic Monitoring – $24.99/month + 13% HST ($3.25) = $28.24/month'));
  assert.ok(text.includes('Smart Monitoring – $32.99/month + 13% HST ($4.29) = $37.28/month'));
  assert.ok(text.includes('Basic Monitoring') && text.includes('$24.99/month') && text.includes('$3.25') && text.includes('$28.24/month'));
  assert.ok(text.includes('Smart Monitoring') && text.includes('$32.99/month') && text.includes('$4.29') && text.includes('$37.28/month'));
});

t('billing terms are printed', () => {
  const text = allText(twoRuns);
  for (const line of pdf.TERMS) {
    assert.ok(text.includes(line.slice(0, 40)), `missing term "${line.slice(0, 40)}"`);
  }
});

t('every anchor is one white 6pt run; signer anchors only for existing signers', () => {
  const expected = [ANCHORS.packageBasic, ANCHORS.packageSmart];
  for (const n of [1, 2]) expected.push(ANCHORS.signHere(n), ANCHORS.fullName(n), ANCHORS.dateSigned(n));
  for (const a of expected) {
    const run = twoRuns.find((r) => r.text === a);
    assert.ok(run, `anchor ${a} missing`);
    assert.strictEqual(run.fill, '1 1 1', `anchor ${a} is not white`);
    assert.strictEqual(run.size, 6, `anchor ${a} is not 6pt`);
  }
  for (const a of [ANCHORS.signHere(3), ANCHORS.fullName(3), ANCHORS.dateSigned(3)]) {
    assert.ok(!twoRuns.some((r) => r.text.includes(a)), `unexpected ${a}`);
  }
  // Visible text is never white.
  assert.ok(twoRuns.filter((r) => r.fill === '1 1 1').every((r) => r.text.startsWith('\\g')));
});

t('one signer → only \\gsig1\\ (non-signing and email-less purchasers get no block)', async () => {
  const buf = await pdf.buildAgreementPdf(
    pdf.agreementData(
      contract([
        { name: 'Solo Buyer', email: 'solo@example.com' },
        { name: 'Listed Only', email: 'listed@example.com', signs: false },
        { name: 'No Email', email: '' },
      ])
    ),
    { compress: false }
  );
  const runs = textRuns(buf);
  assert.ok(runs.some((r) => r.text === ANCHORS.signHere(1)));
  assert.ok(!runs.some((r) => r.text === ANCHORS.signHere(2)));
  assert.ok(allText(runs).includes('Listed Only')); // still listed as a purchaser
});

t('renderAgreementForContract uses the contract termsVersion without a DB', async () => {
  const buf = await pdf.renderAgreementForContract({ ...contract(two), termsVersion: '2027-01' });
  assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
});

module.exports = done();

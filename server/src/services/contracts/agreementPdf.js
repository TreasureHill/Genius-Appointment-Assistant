// The alarm monitoring agreement PDF (pdfkit, US Letter, Helvetica). No
// DocuSign template: DocuSign places its tabs on the anchor strings we draw.
//
// Owner: DocuSign track (tests: contractPdf.test.js).
//
// Content (plan): title "Genius Smart Home — Alarm Monitoring Agreement" +
// contract number + terms version; property box (Project / Model / Lot /
// Address / Closing); purchasers (templateRender.joinNames); equipment text
// verbatim from the addendum ($980 "included in your APS addendum", not
// billed); the two package lines each with its radio anchor at the left and
// pricing.describeQuote(); billing TERMS; one signature block per signer with
// \gsigN\ \gnamN\ \gdatN\. Anchors: white, 6pt Helvetica, one text() call,
// lineBreak:false, and only for signers that exist.

const PDFDocument = require('pdfkit');
const env = require('../../config/env');
const { ANCHORS, buildSigners } = require('./signers');
const { allQuotes, describeQuote, fmtCad } = require('./pricing');
const { joinNames } = require('../templateRender');

// Placeholder billing terms — Treasure Hill legal must approve before go-live.
// Bump Setting.alarm.termsVersion whenever this changes.
const TERMS = [
  'PLACEHOLDER — pending legal review.',
  'Monitoring is month-to-month. Your first monthly charge is made when you set up payment after signing, then on the same day each month.',
  'Prices are shown before 13% HST, which is added to each charge.',
  'Your card is kept on file with our payment processor (Stripe). Failed payments are retried automatically.',
  'We email a reminder before each charge and a receipt after it, unless you turn these off.',
  'Monitoring may be cancelled by written notice to Genius Smart Home.',
];

// Word for word from the "Security / ALARMMON" line of the Treasure Hill
// Sales Contract Addendum, so the purchaser recognises what they already
// bought. The one-time price is NOT billed here (see EQUIPMENT_PRICE_NOTE).
const EQUIPMENT_TEXT =
  'Alarm System - Includes 1 keypad (standard or smart touchscreen), alarm control panel, 3 door contacts, and 2 interior motion sensors. System includes professional rough-in, installation, and training. Choose between Basic Monitoring (no app functionality) or Smart Monitoring with mobile app control and notifications. Both options include monitoring, which is for $24.99/month for Basic Monitoring or $32.99/month for Smart Monitoring.';
const EQUIPMENT_PRICE_NOTE =
  'The one-time alarm system price ($980.00) is included in your Agreement of Purchase and Sale addendum and is not billed under this agreement. This agreement covers the monthly monitoring only.';

const TITLE = 'Genius Smart Home — Alarm Monitoring Agreement';
const MARGIN = 54;
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#BBBBBB';
// Heading + three 34pt lines; a block is never split across pages.
const SIGNATURE_BLOCK_HEIGHT = 150;

/**
 * Plain data for the PDF (pure).
 * @param {object} contract  AlarmContract (doc or lean)
 * @param {{termsVersion?: string, signers?: import('./signers').SignerSpec[]}} [opts]
 *        signers default to buildSigners(contract.purchasers, {mode: contract.signingMode})
 * @returns {{number, termsVersion, property:{projectName,model,lotNumber,address,closingDate},
 *   purchaserNames: string, purchasers: Array<{name,email}>, packages: Array<ReturnType<import('./pricing').quote>>,
 *   signers: import('./signers').SignerSpec[], terms: string[], generatedAt: Date}}
 * @throws no_signer_email (via buildSigners) when no purchaser can sign
 */
function agreementData(contract, opts = {}) {
  const c = contract || {};
  const signers =
    opts.signers ||
    buildSigners(c.purchasers || [], {
      mode: c.signingMode === 'in_person' ? 'in_person' : 'remote',
      contractId: c._id ? String(c._id) : '',
    });
  const prop = c.property || {};
  const purchasers = (c.purchasers || [])
    .filter((p) => p && (p.name || p.email))
    .map((p) => ({ name: String(p.name || '').trim(), email: String(p.email || '').trim().toLowerCase() }));
  return {
    number: c.number || '',
    termsVersion: opts.termsVersion || c.termsVersion || '',
    property: {
      projectName: prop.projectName || '',
      model: prop.model || '',
      lotNumber: prop.lotNumber || '',
      address: prop.address || '',
      closingDate: prop.closingDate ? new Date(prop.closingDate) : null,
    },
    purchaserNames: joinNames(purchasers.map((p) => p.name || p.email)),
    purchasers,
    packages: allQuotes().map((q) => ({ ...q, line: describeQuote(q.package) })),
    signers,
    terms: TERMS.slice(),
    hstNumber: (env.hst && env.hst.registrationNumber) || '',
    generatedAt: opts.generatedAt || new Date(),
  };
}

// Closing dates are date-only values stored at 12:00 UTC; print them in UTC
// so the day never shifts.
function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

// Hidden anchor for a DocuSign tab: white 6pt Helvetica in ONE text() call
// with lineBreak:false, so the string is never split or wrapped (DocuSign
// searches the text layer). Leaves the cursor and fill colour as they were.
function drawAnchor(doc, anchor, x, y) {
  const { x: cx, y: cy } = doc;
  doc.font('Helvetica').fontSize(6).fillColor('#FFFFFF').text(anchor, x, y, { lineBreak: false });
  doc.fillColor(INK);
  doc.x = cx;
  doc.y = cy;
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function heading(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(text, MARGIN, doc.y);
  doc.moveDown(0.3);
}

function para(doc, text, opts = {}) {
  doc
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(opts.size || 9.5)
    .fillColor(opts.color || INK)
    .text(text, opts.x || MARGIN, doc.y, { width: opts.width || contentWidth(doc), align: 'left' });
}

function propertyBox(doc, property) {
  const rows = [
    ['Project', property.projectName],
    ['Model', property.model],
    ['Lot', property.lotNumber],
    ['Address', property.address],
    ['Closing date', fmtDate(property.closingDate)],
  ];
  const top = doc.y;
  const w = contentWidth(doc);
  const labelW = 90;
  let y = top + 8;
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, MARGIN + 10, y, { width: labelW });
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(INK)
      .text(value || '—', MARGIN + 10 + labelW, y, { width: w - labelW - 20 });
    y = Math.max(doc.y, y + 12) + 4;
  }
  doc.lineWidth(0.75).strokeColor(RULE).rect(MARGIN, top, w, y - top + 4).stroke();
  doc.x = MARGIN;
  doc.y = y + 10;
}

// One package line: the radio anchor sits in the left gutter where DocuSign
// draws the radio button, the price text to its right.
function packageLine(doc, q, anchor) {
  ensureSpace(doc, 40);
  const y = doc.y;
  drawAnchor(doc, anchor, MARGIN + 4, y + 1);
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(q.line, MARGIN + 26, y, { width: contentWidth(doc) - 26 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(q.desc, MARGIN + 26, doc.y + 1, { width: contentWidth(doc) - 26 });
  doc.fillColor(INK);
  doc.y += 8;
}

// Signature block for signer n: signature line, printed-name line, date line.
// Anchors sit just above the left end of each line.
function signatureBlock(doc, signer) {
  ensureSpace(doc, SIGNATURE_BLOCK_HEIGHT);
  const top = doc.y + 6;
  const w = contentWidth(doc);
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(INK)
    .text(`Purchaser ${signer.n}: ${signer.name}`, MARGIN, top, { width: w });
  const fields = [
    ['Signature', signer.anchors.signHere, 300],
    ['Printed name', signer.anchors.fullName, 300],
    ['Date', signer.anchors.dateSigned, 180],
  ];
  let y = top + 34;
  for (const [label, anchor, len] of fields) {
    drawAnchor(doc, anchor, MARGIN + 80, y - 10);
    doc.lineWidth(0.75).strokeColor(INK).moveTo(MARGIN + 78, y).lineTo(MARGIN + 78 + len, y).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label, MARGIN, y - 9, { width: 75, lineBreak: false });
    y += 34;
  }
  doc.fillColor(INK);
  doc.x = MARGIN;
  doc.y = y;
}

/**
 * Render the PDF.
 * @param {ReturnType<typeof agreementData>} data
 * @param {{compress?: boolean}} [opts] compress:false keeps text streams readable (tests grep anchors)
 * @returns {Promise<Buffer>} starts with "%PDF"
 */
function buildAgreementPdf(data, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      compress,
      bufferPages: true,
      info: { Title: 'Genius Alarm Monitoring Agreement', Author: 'Genius Smart Home', Subject: data.number || '' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      // ---- Title -------------------------------------------------------------
      doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(TITLE, MARGIN, MARGIN);
      doc.moveDown(0.2);
      const meta = [
        data.number ? `Agreement no. ${data.number}` : 'Draft agreement',
        data.termsVersion ? `Terms version ${data.termsVersion}` : '',
        `Prepared ${fmtDate(data.generatedAt)}`,
      ].filter(Boolean);
      para(doc, meta.join('   ·   '), { size: 9, color: MUTED });
      para(doc, 'Genius Smart Home, a Treasure Hill company', { size: 9, color: MUTED });
      doc.moveDown(0.6);

      // ---- Property -----------------------------------------------------------
      heading(doc, 'Property');
      propertyBox(doc, data.property || {});

      // ---- Purchasers ---------------------------------------------------------
      heading(doc, 'Purchasers');
      for (const p of data.purchasers || []) {
        para(doc, p.email ? `${p.name || p.email}  (${p.email})` : p.name);
      }
      if (!(data.purchasers || []).length) para(doc, '—');

      // ---- Equipment ----------------------------------------------------------
      heading(doc, 'Alarm system');
      para(doc, EQUIPMENT_TEXT);
      doc.moveDown(0.4);
      para(doc, EQUIPMENT_PRICE_NOTE, { size: 9, color: MUTED });

      // ---- Package choice -----------------------------------------------------
      heading(doc, 'Choose your monitoring package');
      const primary = (data.signers || [])[0];
      para(
        doc,
        `${primary ? `${primary.name} (Purchaser 1)` : 'Purchaser 1'} selects one package when signing. HST is 13% and is added to each monthly charge.`,
        { size: 9, color: MUTED }
      );
      doc.moveDown(0.5);
      const anchorFor = { basic: ANCHORS.packageBasic, smart: ANCHORS.packageSmart };
      for (const q of data.packages || []) packageLine(doc, q, anchorFor[q.package]);

      // ---- Billing terms ------------------------------------------------------
      heading(doc, 'Billing terms');
      (data.terms || []).forEach((line, i) => {
        ensureSpace(doc, 24);
        para(doc, `${i + 1}.  ${line}`);
        doc.moveDown(0.25);
      });
      if (data.hstNumber) para(doc, `HST registration no. ${data.hstNumber}`, { size: 9, color: MUTED });

      // ---- Signatures ---------------------------------------------------------
      // Keep the heading with the first signature block.
      ensureSpace(doc, 60 + SIGNATURE_BLOCK_HEIGHT);
      heading(doc, 'Signatures');
      para(doc, 'By signing, each purchaser agrees to this agreement and the package selected above.', {
        size: 9,
        color: MUTED,
      });
      for (const s of data.signers || []) signatureBlock(doc, s);

      // ---- Footer on every page ----------------------------------------------
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        // Writing inside the bottom margin would make pdfkit add a page.
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            `${data.number || 'Draft'}  ·  Page ${i - range.start + 1} of ${range.count}`,
            MARGIN,
            doc.page.height - 36,
            { width: contentWidth(doc), align: 'center', lineBreak: false }
          );
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Convenience: agreementData(contract, {termsVersion: contract.termsVersion ||
 * Setting.alarm.termsVersion}) → buildAgreementPdf. Used by the preview route
 * and envelopeSync.sendContract.
 * @param {object} contract
 * @param {{signers?: import('./signers').SignerSpec[], termsVersion?: string}} [opts]
 * @returns {Promise<Buffer>}
 */
async function renderAgreementForContract(contract, opts = {}) {
  let termsVersion = opts.termsVersion || (contract && contract.termsVersion) || '';
  if (!termsVersion) {
    // Lazy require: keeps this module (and its tests) free of Mongo.
    const Setting = require('../../models/Setting');
    const setting = await Setting.getSingleton();
    termsVersion = (setting.alarm && setting.alarm.termsVersion) || '';
  }
  return buildAgreementPdf(agreementData(contract, { termsVersion, signers: opts.signers }));
}

module.exports = {
  ANCHORS,
  TERMS,
  EQUIPMENT_TEXT,
  EQUIPMENT_PRICE_NOTE,
  agreementData,
  buildAgreementPdf,
  renderAgreementForContract,
  fmtDate,
};

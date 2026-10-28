const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const AlarmContract = require('../models/AlarmContract');
const ContractDocument = require('../models/ContractDocument');
const ContractEvent = require('../models/ContractEvent');
const ContractPayment = require('../models/ContractPayment');
const PortalUser = require('../models/PortalUser');
const Lot = require('../models/Lot');
const Setting = require('../models/Setting');
const env = require('../config/env');
const { contractError, sendError, httpErrorFor } = require('../services/contracts/errors');
const { assertCan, ACTION_GUARDS } = require('../services/contracts/status');
const { logContractEvent } = require('../services/contracts/eventLogger');
const metrics = require('../services/contracts/metrics');
const envelopeSync = require('../services/contracts/envelopeSync');
const agreementPdf = require('../services/contracts/agreementPdf');
const docusign = require('../services/contracts/docusign');
const billing = require('../services/contracts/billing');
const stripeClient = require('../services/contracts/stripeClient');
const portalTokens = require('../services/contracts/portalTokens');
const emails = require('../services/contracts/emails');

// Admin API for alarm monitoring contracts, mounted at /api/contracts AFTER
// the requireAuth wall (req.user = admin claims; req.user.username for logs).
//
// Endpoints (plan "Routes"): GET /summary, GET /, GET /export.csv, POST /,
// GET/PATCH/DELETE /:id, GET /:id/agreement-preview.pdf, POST /:id/send,
// /:id/signing-view, /:id/resend, /:id/void, /:id/regenerate, /:id/refresh,
// /:id/manual-signed (multipart), /:id/documents (multipart, kind 'other'),
// /:id/set-package, /:id/resend-invite, /:id/send-reminder,
// /:id/payment-link, /:id/purchasers/:index/contact, /:id/cancel, /:id/sync-stripe,
// /:id/payments/:paymentId/email, GET /:id/documents/:kind.
//
// Every error goes through services/contracts/errors.sendError, which maps
// err.code → HTTP status (CONTRACT_ERROR_HTTP, the same idea as
// CALL_ERROR_HTTP in routes/lots.js) and passes consentUrl / problems through
// for the client. The state machine lives in the services: this file checks
// the action guard up front for a clear 409, then hands the work over.
//
// Mutating endpoints answer with the same payload as GET /:id (plus any
// extra result fields) so the page can replace its state in one go.
const router = express.Router();

const MAX_BYTES = ContractDocument.MAX_BYTES; // 15 MB
// Memory storage: the file goes straight into a Mongo Buffer (never to disk —
// deploy.ps1 resets the repo dir).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

// Extra files staff may attach (kind 'other'): scans and PDFs only, so the
// download route never serves anything a browser would execute.
const OTHER_TYPES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

const REFRESH_THROTTLE_MS = 15 * 60 * 1000;
const IN_PERSON_REFRESH_THROTTLE_MS = 5 * 1000;
const PURCHASER_ROLES = ['buyer', 'coBuyer', 'thirdBuyer'];
const SIGNING_MODES = ['remote', 'in_person', 'paper'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Short names for the stored PDFs (also accepted: the full kind names).
const DOCUMENT_ALIASES = {
  unsigned: 'agreement_unsigned',
  signed: 'agreement_signed',
  certificate: 'certificate',
  agreement_unsigned: 'agreement_unsigned',
  agreement_signed: 'agreement_signed',
};
const DOCUMENT_REF = { agreement_unsigned: 'unsigned', agreement_signed: 'signed', certificate: 'certificate' };
const DOCUMENT_SUFFIX = { agreement_unsigned: 'unsigned', agreement_signed: 'signed', certificate: 'certificate' };

const who = (req) => (req.user && req.user.username) || '';
const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

// Wrap a handler so every throw becomes a mapped JSON error.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else res.destroy();
  }
};

async function loadContract(id) {
  if (!mongoose.isValidObjectId(id)) throw contractError('not_found', 'Contract not found');
  const c = await AlarmContract.findById(id).lean();
  if (!c) throw contractError('not_found', 'Contract not found');
  return c;
}

// ---------------------------------------------------------------------------
// Input cleaning
// ---------------------------------------------------------------------------

/**
 * Purchasers from the send dialog → stored shape. Up to 3 (one per lot buyer
 * role). Couples sharing one inbox are fine (signers are deduped on
 * email+name, not email). Each signer needs a valid email unless the
 * contract is a paper one.
 */
function cleanPurchasers(list, { signingMode } = {}) {
  if (!Array.isArray(list)) throw contractError('validation_failed', 'Purchasers are required', { field: 'purchasers' });
  const rows = list.filter((p) => p && (str(p.name) || str(p.email)));
  if (!rows.length) throw contractError('validation_failed', 'Add at least one purchaser', { field: 'purchasers' });
  if (rows.length > PURCHASER_ROLES.length) {
    throw contractError('validation_failed', `At most ${PURCHASER_ROLES.length} purchasers`, { field: 'purchasers' });
  }
  const usedRoles = new Set();
  return rows.map((p, i) => {
    const role = PURCHASER_ROLES.includes(p.role) && !usedRoles.has(p.role) ? p.role : PURCHASER_ROLES.find((r) => !usedRoles.has(r));
    usedRoles.add(role);
    const email = str(p.email, 254).toLowerCase();
    const signs = p.signs !== false;
    if (!str(p.name)) throw contractError('validation_failed', `Purchaser ${i + 1} needs a name`, { field: `purchasers.${i}.name` });
    if (email && !EMAIL_RE.test(email)) {
      throw contractError('validation_failed', `"${email}" is not a valid email`, { field: `purchasers.${i}.email` });
    }
    if (signs && !email && signingMode !== 'paper') {
      throw contractError('validation_failed', 'Each purchaser who signs needs a valid email', { field: `purchasers.${i}.email` });
    }
    return { role, name: str(p.name), email, phone: str(p.phone, 40), signs };
  });
}

// Property snapshot fields present in `input` → { field: value }. Closing date
// is date-only (12:00 UTC).
function cleanProperty(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of ['projectName', 'model', 'lotNumber', 'address']) {
    if (k in input) out[k] = str(input[k]);
  }
  if ('closingDate' in input) {
    const d = metrics.parseDateOnly(input.closingDate);
    if (d === undefined) throw contractError('validation_failed', 'Closing date is invalid', { field: 'property.closingDate' });
    out.closingDate = d;
  }
  return out;
}

function cleanSigningMode(v, fallback) {
  if (v == null || v === '') return fallback;
  if (!SIGNING_MODES.includes(v)) throw contractError('validation_failed', 'Signing mode must be remote, in_person or paper', { field: 'signingMode' });
  return v;
}

// Purchasers → lot buyers for "save to lot", keeping each buyer's marketing
// opt-out (matched by role, then email).
function purchasersToBuyers(purchasers, existing = []) {
  return purchasers.map((p) => {
    const prev = existing.find((b) => b.role === p.role) || existing.find((b) => p.email && b.email === p.email);
    return { role: p.role, name: p.name, email: p.email, phone: p.phone, optedOut: Boolean(prev && prev.optedOut) };
  });
}

// ---------------------------------------------------------------------------
// The detail payload (GET /:id and every action's answer)
// ---------------------------------------------------------------------------

function canPerformSafe(name, c) {
  try {
    return Boolean(ACTION_GUARDS[name](c));
  } catch {
    return false;
  }
}

function actionsFor(c) {
  const out = {};
  for (const [name, guard] of Object.entries(ACTION_GUARDS)) {
    try {
      out[name] = Boolean(guard(c));
    } catch {
      out[name] = false;
    }
  }
  return out;
}

function portalUserView(u, now) {
  return {
    _id: u._id,
    email: u.email,
    name: u.name || '',
    hasPassword: Boolean(u.passwordSetAt),
    passwordSetAt: u.passwordSetAt || null,
    invitePending: u.tokenPurpose === 'invite' && Boolean(u.tokenExpiresAt) && new Date(u.tokenExpiresAt) > now,
    inviteExpiresAt: u.tokenPurpose === 'invite' ? u.tokenExpiresAt || null : null,
    lastLoginAt: u.lastLoginAt || null,
    locked: Boolean(u.lockedUntil && new Date(u.lockedUntil) > now),
    disabled: Boolean(u.disabled),
  };
}

async function detail(id) {
  const now = new Date();
  const contract = await AlarmContract.findById(id)
    .populate('project', 'name marketingName')
    .populate('lot', 'lotNumber address model closing status')
    .lean();
  if (!contract) throw contractError('not_found', 'Contract not found');
  const lotId = (contract.lot && contract.lot._id) || contract.lot;
  const [events, payments, documents, portalUsers, history, setting] = await Promise.all([
    ContractEvent.find({ contract: contract._id }).sort({ createdAt: -1 }).limit(300).lean(),
    ContractPayment.find({ contract: contract._id }).sort({ periodStart: -1, createdAt: -1 }).lean(),
    ContractDocument.find({ contract: contract._id }).select('-data').sort({ createdAt: -1 }).lean(),
    // Explicit field list: never tokenHash / passwordHash.
    PortalUser.find({ contracts: contract._id })
      .select('email name passwordSetAt lastLoginAt tokenPurpose tokenExpiresAt lockedUntil disabled')
      .sort({ email: 1 })
      .lean(),
    AlarmContract.find({ lot: lotId, _id: { $ne: contract._id } })
      .select('number status isCurrent createdAt regeneratedFrom')
      .sort({ createdAt: -1 })
      .lean(),
    Setting.getSingleton(),
  ]);
  const b = contract.billing || {};
  const alarm = (setting && setting.alarm) || {};
  return {
    contract,
    events,
    payments,
    documents,
    portalUsers: portalUsers.map((u) => portalUserView(u, now)),
    history,
    actions: actionsFor(contract),
    nextChargeAt: metrics.nextChargeFor(contract),
    monthsActive: metrics.monthsActiveFor(contract, now),
    links: {
      stripeCustomer: b.customerId ? stripeClient.dashboardUrl(`customers/${b.customerId}`) : '',
      stripeSubscription: b.subscriptionId ? stripeClient.dashboardUrl(`subscriptions/${b.subscriptionId}`) : '',
    },
    config: {
      docusign: env.docusign.dispatchable,
      docusignConnect: env.docusign.connectEnabled,
      stripe: env.stripe.configured,
      stripeBillable: env.stripe.billable,
      stripeMode: env.stripe.mode,
    },
    // Global switches, so the page can say "reminders are off in Settings".
    globals: {
      paymentRemindersEnabled: alarm.paymentRemindersEnabled !== false,
      autoSendInvoices: alarm.autoSendInvoices !== false,
      sendFailedPaymentEmails: alarm.sendFailedPaymentEmails !== false,
    },
  };
}

// Map a non-ok email result ({ok:false, skipped|error}) to a thrown error.
function emailResultError(r) {
  if (r.skipped === 'smtp_not_configured') return contractError('not_configured', 'SMTP is not configured');
  if (r.skipped === 'not_implemented') return contractError('not_implemented', 'Contract emails are not available yet');
  if (r.skipped === 'no_recipient') return contractError('no_signer_email', 'The primary purchaser has no email address');
  if (r.skipped === 'disabled') return contractError('invalid_state', 'This email is turned off');
  if (r.skipped === 'not_paid' || r.skipped === 'not_open') return contractError('invalid_state', `This payment is ${r.skipped.replace('not_', 'not ')}`);
  if (r.skipped === 'claimed') return contractError('invalid_state', 'This email is being sent right now');
  if (r.error === 'not_found') return contractError('not_found', 'Payment not found');
  return contractError('email_failed', `Email failed: ${r.error || r.skipped || 'unknown error'}`);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

router.get(
  '/summary',
  handle(async (req, res) => {
    const { project, projects, from, to } = req.query;
    const fromD = from ? metrics.parseDateOnly(from) : null;
    const toD = to ? metrics.parseDateOnly(to) : null;
    if (fromD === undefined || toD === undefined) throw contractError('validation_failed', 'Invalid date range');
    // `to` is inclusive of the whole day.
    const toEnd = toD ? new Date(toD.getTime() + 12 * 60 * 60 * 1000 - 1) : null;
    const fromStart = fromD ? new Date(fromD.getTime() - 12 * 60 * 60 * 1000) : null;
    res.json(await metrics.summary({ projectIds: metrics.toList(projects || project), from: fromStart, to: toEnd }));
  })
);

router.get(
  '/',
  handle(async (req, res) => {
    res.json(await metrics.listRows(req.query || {}));
  })
);

router.get(
  '/export.csv',
  handle(async (req, res) => {
    const csv = await metrics.exportCsv(req.query || {});
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="monitoring-contracts-${day}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // BOM so Excel reads the accents in names as UTF-8.
    res.send(`﻿${csv}`);
  })
);

// ---------------------------------------------------------------------------
// Create / read / edit / delete
// ---------------------------------------------------------------------------

router.post(
  '/',
  handle(async (req, res) => {
    const body = req.body || {};
    if (!mongoose.isValidObjectId(body.lotId)) throw contractError('validation_failed', 'Choose a lot', { field: 'lotId' });
    const lot = await Lot.findById(body.lotId).populate('project', 'name marketingName');
    if (!lot) throw contractError('not_found', 'Lot not found');
    if (!lot.closing || !lot.closing.closed) {
      throw contractError('lot_not_closed', 'Mark the lot closed before preparing its monitoring agreement');
    }
    const existing = await AlarmContract.findOne({ lot: lot._id, isCurrent: true }).select('number status').lean();
    if (existing) {
      throw contractError('contract_exists', `This lot already has contract ${existing.number} (${existing.status.replace(/_/g, ' ')})`);
    }

    const setting = await Setting.getSingleton();
    const alarm = setting.alarm || {};
    const signingMode = cleanSigningMode(body.signingMode, alarm.defaultSigningMode || 'remote');
    // Purchasers default to the lot's buyers (the dialog prefills them too).
    const rawPurchasers = Array.isArray(body.purchasers) && body.purchasers.length ? body.purchasers : (lot.buyers || []).map((b) => b.toObject());
    const purchasers = cleanPurchasers(rawPurchasers, { signingMode });
    const project = lot.project || {};
    const property = {
      projectName: project.marketingName || project.name || '',
      model: lot.model || '',
      lotNumber: lot.lotNumber || '',
      address: lot.address || '',
      closingDate: (lot.closing && lot.closing.closingDate) || null,
      ...cleanProperty(body.property),
    };

    const number = await AlarmContract.allocateNumber();
    const contract = await new AlarmContract({
      number,
      project: project._id || lot.project,
      lot: lot._id,
      property,
      purchasers,
      signingMode,
      termsVersion: alarm.termsVersion || '',
      notes: str(body.notes, 5000),
      createdBy: who(req),
    }).save(); // E11000 on the one-current-per-lot index → 409 contract_exists

    const lotSet = { alarmContract: contract._id };
    if (body.saveToLot) {
      lotSet.buyers = purchasersToBuyers(purchasers, lot.buyers || []);
      if (property.model) lotSet.model = property.model;
    }
    await Lot.updateOne({ _id: lot._id }, { $set: lotSet });
    await logContractEvent({
      contract,
      type: 'created',
      actor: 'user',
      actorName: who(req),
      message: `Agreement ${number} prepared (${signingMode.replace('_', ' ')} signing)${body.saveToLot ? '; purchasers saved to the lot' : ''}`,
      toStatus: 'draft',
    });

    if (body.send && signingMode !== 'paper') {
      try {
        await envelopeSync.sendContract(contract._id, { user: who(req) });
      } catch (err) {
        // The draft stands; tell the client why sending failed.
        const { status, body: errBody } = httpErrorFor(err);
        if (status >= 500) console.error('[contracts] send after create failed', errBody.error, err.message);
        return res.status(status).json({ ...errBody, created: true, ...(await detail(contract._id)) });
      }
    }
    res.status(201).json(await detail(contract._id));
  })
);

router.get(
  '/:id',
  handle(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw contractError('not_found', 'Contract not found');
    res.json(await detail(req.params.id));
  })
);

// Draft only: purchasers, property, signingMode. Any status: reminders,
// invoice emails, notes.
router.patch(
  '/:id',
  handle(async (req, res) => {
    const body = req.body || {};
    const c = await loadContract(req.params.id);
    const draftSet = {};
    const anySet = {};
    const changes = [];

    const signingMode = 'signingMode' in body ? cleanSigningMode(body.signingMode, c.signingMode) : c.signingMode;
    if ('signingMode' in body && signingMode !== c.signingMode) {
      draftSet.signingMode = signingMode;
      changes.push(`signing mode ${signingMode.replace('_', ' ')}`);
    }
    if ('purchasers' in body) {
      draftSet.purchasers = cleanPurchasers(body.purchasers, { signingMode });
      changes.push('purchasers');
    } else if (draftSet.signingMode) {
      // A switch away from paper makes emails required again.
      cleanPurchasers(c.purchasers, { signingMode });
    }
    if ('property' in body) {
      const p = cleanProperty(body.property);
      for (const [k, v] of Object.entries(p)) draftSet[`property.${k}`] = v;
      if (Object.keys(p).length) changes.push('property');
    }

    const remindersEnabled = body.reminders && 'enabled' in body.reminders ? body.reminders.enabled : body.remindersEnabled;
    if (remindersEnabled != null) {
      anySet['reminders.enabled'] = Boolean(remindersEnabled);
      changes.push(`payment reminders ${remindersEnabled ? 'on' : 'off'}`);
    }
    const invoiceEnabled = body.invoiceEmails && 'enabled' in body.invoiceEmails ? body.invoiceEmails.enabled : body.invoiceEmailsEnabled;
    if (invoiceEnabled != null) {
      anySet['invoiceEmails.enabled'] = Boolean(invoiceEnabled);
      changes.push(`invoice emails ${invoiceEnabled ? 'on' : 'off'}`);
    }
    if ('notes' in body) {
      anySet.notes = String(body.notes == null ? '' : body.notes).slice(0, 5000);
      changes.push('notes');
    }

    const hasDraft = Object.keys(draftSet).length > 0;
    if (!hasDraft && !Object.keys(anySet).length) return res.json(await detail(c._id));
    if (hasDraft) assertCan('edit', c);

    // Draft edits are a compare-and-set on "still a draft nobody is sending",
    // so an edit can't slip in between the send claim and the envelope.
    const filter = hasDraft ? { _id: c._id, status: 'draft', 'envelope.sendClaimedAt': null } : { _id: c._id };
    const r = await AlarmContract.updateOne(filter, { $set: { ...draftSet, ...anySet } }, { runValidators: true });
    if (!r.matchedCount) throw contractError('invalid_state', 'The agreement is being sent and can no longer be edited');
    await logContractEvent({
      contract: c,
      type: 'updated',
      actor: 'user',
      actorName: who(req),
      message: `Updated ${changes.join(', ')}`,
      meta: { fields: [...Object.keys(draftSet), ...Object.keys(anySet)] },
    });
    res.json(await detail(c._id));
  })
);

router.delete(
  '/:id',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('delete', c);
    const r = await AlarmContract.deleteOne({ _id: c._id, status: 'draft', 'envelope.sendClaimedAt': null });
    if (!r.deletedCount) throw contractError('invalid_state', 'Only an unsent draft can be deleted');
    await Promise.all([ContractDocument.deleteMany({ contract: c._id }), ContractEvent.deleteMany({ contract: c._id })]);

    // If this draft replaced a declined / voided contract, that one becomes
    // the lot's current contract again (so it can be regenerated later).
    let restored = null;
    if (c.regeneratedFrom) {
      try {
        const u = await AlarmContract.updateOne({ _id: c.regeneratedFrom, isCurrent: false }, { $set: { isCurrent: true } });
        if (u.modifiedCount) restored = c.regeneratedFrom;
      } catch (err) {
        // Another current contract exists (unique index): leave it.
        console.warn('[contracts] could not restore previous contract', err.message);
      }
    }
    await Lot.updateOne({ _id: c.lot, alarmContract: c._id }, { $set: { alarmContract: restored } });
    res.json({ ok: true, deleted: String(c._id), restored: restored ? String(restored) : null });
  })
);

// ---------------------------------------------------------------------------
// Agreement + signing
// ---------------------------------------------------------------------------

router.get(
  '/:id/agreement-preview.pdf',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    // Rendered on the fly, nothing stored. Sent contracts download the stored
    // copy instead (documents/unsigned) so what staff see is what was signed.
    const pdf = await agreementPdf.renderAgreementForContract(c);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${c.number}-preview.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  })
);

router.post(
  '/:id/send',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('send', c);
    // Claim (draft + sendClaimedAt) → PDF → envelope → sent, rolled back on
    // failure, all inside envelopeSync.
    await envelopeSync.sendContract(c._id, { user: who(req) });
    res.json(await detail(c._id));
  })
);

// In-person signing on a tablet: a single-use embedded signing URL for one
// purchaser. DocuSign answers not_your_turn until the previous signer is done.
router.post(
  '/:id/signing-view',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('signing_view', c);
    const wanted = req.body && req.body.recipientId ? String(req.body.recipientId) : '';
    const signers = (c.purchasers || []).filter((p) => p.signs !== false && p.recipientId && p.clientUserId);
    const p = wanted
      ? signers.find((s) => s.recipientId === wanted)
      : signers
          .filter((s) => !['signed', 'completed', 'declined'].includes(s.signStatus))
          .sort((a, b) => (a.routingOrder || 0) - (b.routingOrder || 0))[0];
    if (!p) throw contractError('invalid_state', 'No purchaser is waiting to sign in person');
    if (['signed', 'completed'].includes(p.signStatus)) throw contractError('invalid_state', `${p.name} has already signed`);
    const returnUrl = `${env.appUrl}/contracts/${c._id}/signing-return?recipientId=${encodeURIComponent(p.recipientId)}`;
    const { url } = await docusign.createRecipientView(c.envelope.id, {
      recipientId: p.recipientId,
      name: p.name,
      email: p.email,
      clientUserId: p.clientUserId,
      returnUrl,
    });
    await logContractEvent({
      contract: c,
      type: 'admin_action',
      actor: 'user',
      actorName: who(req),
      message: `Opened in-person signing for ${p.name}`,
      meta: { recipientId: p.recipientId },
    });
    res.json({ url, recipientId: p.recipientId, name: p.name });
  })
);

router.post(
  '/:id/resend',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('resend', c);
    await envelopeSync.resendContract(c._id, { user: who(req) });
    res.json(await detail(c._id));
  })
);

router.post(
  '/:id/void',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('void', c);
    const reason = str(req.body && req.body.reason, 200);
    if (!reason) throw contractError('validation_failed', 'A reason is required to void', { field: 'reason' });
    await envelopeSync.voidContract(c._id, { reason, user: who(req) });
    res.json(await detail(c._id));
  })
);

// After a decline, a void or a cancellation: a fresh draft with the same
// purchasers and property (staff edit them for a new owner). The old contract keeps its documents and history (isCurrent
// false) for audit.
router.post(
  '/:id/regenerate',
  handle(async (req, res) => {
    const old = await loadContract(req.params.id);
    assertCan('regenerate', old);
    if (!old.isCurrent) throw contractError('invalid_state', 'This contract has already been replaced');
    const setting = await Setting.getSingleton();
    const signingMode = cleanSigningMode(req.body && req.body.signingMode, old.signingMode === 'paper' ? 'remote' : old.signingMode);

    // Retire the old one first (compare-and-set) so the partial unique index
    // lets the new draft in; undone below if the create fails.
    const retire = await AlarmContract.updateOne(
      { _id: old._id, isCurrent: true, status: { $in: ['declined', 'voided', 'canceled'] } },
      { $set: { isCurrent: false } }
    );
    if (!retire.modifiedCount) throw contractError('invalid_state', 'This contract changed; reload and try again');

    let fresh;
    try {
      const number = await AlarmContract.allocateNumber();
      fresh = await new AlarmContract({
        number,
        project: old.project,
        lot: old.lot,
        regeneratedFrom: old._id,
        property: old.property,
        purchasers: (old.purchasers || []).map((p) => ({ role: p.role, name: p.name, email: p.email, phone: p.phone, signs: p.signs !== false })),
        signingMode,
        termsVersion: (setting.alarm && setting.alarm.termsVersion) || old.termsVersion || '',
        notes: old.notes || '',
        createdBy: who(req),
      }).save();
    } catch (err) {
      await AlarmContract.updateOne({ _id: old._id, isCurrent: false }, { $set: { isCurrent: true } }).catch(() => {});
      throw err;
    }
    await Lot.updateOne({ _id: old.lot }, { $set: { alarmContract: fresh._id } });
    await logContractEvent({
      contract: old,
      type: 'regenerated',
      actor: 'user',
      actorName: who(req),
      message: `Replaced by ${fresh.number}`,
      meta: { contractId: String(fresh._id) },
    });
    await logContractEvent({
      contract: fresh,
      type: 'created',
      actor: 'user',
      actorName: who(req),
      message: `Agreement ${fresh.number} prepared to replace ${old.number} (${old.status})`,
      toStatus: 'draft',
      meta: { regeneratedFrom: String(old._id) },
    });
    res.status(201).json(await detail(fresh._id));
  })
);

// Pull the latest from DocuSign (and Stripe when billing exists). Throttled
// to once per 15 minutes per envelope, except when a completed envelope is
// still missing its documents (the completion tail needs a nudge).
router.post(
  '/:id/refresh',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    const hasEnvelope = Boolean(c.envelope && c.envelope.id);
    const hasBilling = Boolean(c.billing && (c.billing.customerId || c.billing.checkoutSessionId));
    if (!hasEnvelope && !hasBilling) throw contractError('invalid_state', 'Nothing to refresh yet: the agreement has not been sent');
    const result = { envelope: null, stripe: null, warnings: [] };

    if (hasEnvelope) {
      const e = c.envelope;
      const stuck = e.status === 'completed' && (!e.completionDoneAt || !(c.documents && c.documents.signed));
      const last = e.lastSyncedAt ? new Date(e.lastSyncedAt).getTime() : 0;
      // In-person signing at a closing table: the return page refreshes right
      // after each signer finishes, so only a short throttle applies while the
      // envelope is still out for signature.
      const inPersonLive = c.signingMode === 'in_person' && (e.status === 'sent' || e.status === 'delivered');
      const wait = last + (inPersonLive ? IN_PERSON_REFRESH_THROTTLE_MS : REFRESH_THROTTLE_MS) - Date.now();
      if (!stuck && wait > 0) {
        result.envelope = { throttled: true, retryAfter: Math.ceil(wait / 1000) };
      } else if (!env.docusign.configured) {
        result.warnings.push('DocuSign is not configured');
      } else {
        result.envelope = await envelopeSync.applyEnvelopeStatus(e.id, { actor: 'user', actorName: who(req) });
        // A completed envelope whose tail never finished: run it now.
        const now = await AlarmContract.findById(c._id).select('envelope.status envelope.completionDoneAt').lean();
        if (now && now.envelope && now.envelope.status === 'completed' && !now.envelope.completionDoneAt) {
          try {
            result.completion = await envelopeSync.completeEnvelope(c._id, { actor: 'user', actorName: who(req) });
          } catch (err) {
            result.warnings.push(`Completion steps failed: ${err.message}`);
          }
        }
      }
    }
    if (hasBilling) {
      if (!env.stripe.configured) {
        result.warnings.push('Stripe is not configured');
      } else {
        try {
          result.stripe = await billing.reconcileContract(c._id, { actor: 'user' });
        } catch (err) {
          result.warnings.push(`Stripe sync failed: ${httpErrorFor(err).body.message}`);
        }
      }
    }
    res.json({ refresh: result, ...(await detail(c._id)) });
  })
);

// Multer errors (file too big, wrong field) → our error codes.
function singleFile(field) {
  return (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, contractError('document_too_large', 'The file is larger than 15 MB'));
      return sendError(res, contractError('invalid_document', err.message || 'Upload failed'));
    });
}

// Paper contract: upload the signed PDF, then the same tail as a DocuSign
// completion (portal users, welcome email, payment).
router.post(
  '/:id/manual-signed',
  singleFile('file'),
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('manual_signed', c);
    if (!req.file) throw contractError('invalid_document', 'Attach the signed agreement PDF', { field: 'file' });
    const body = req.body || {};
    const signedAt = body.signedAt ? metrics.parseDateOnly(body.signedAt) : new Date();
    if (signedAt === undefined || signedAt === null) throw contractError('validation_failed', 'Signed date is invalid', { field: 'signedAt' });
    await envelopeSync.completeManualSigned(c._id, {
      pdfBuffer: req.file.buffer,
      filename: str(req.file.originalname, 200),
      package: body.package,
      signedAt,
      note: String(body.note || '').slice(0, 2000),
      actor: who(req),
    });
    res.json(await detail(c._id));
  })
);

// Extra documents (kind 'other'): scans, amendments. Any status.
router.post(
  '/:id/documents',
  singleFile('file'),
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) throw contractError('invalid_document', 'Choose a file to upload', { field: 'file' });
    const ext = OTHER_TYPES[f.mimetype];
    if (!ext) throw contractError('invalid_document', 'Upload a PDF, PNG or JPEG file', { field: 'file' });
    if (ext === 'pdf' && f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw contractError('invalid_document', 'The uploaded file is not a PDF', { field: 'file' });
    }
    const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const note = String((req.body && req.body.note) || '').slice(0, 2000);
    const doc = await ContractDocument.create({
      contract: c._id,
      envelopeId: '',
      kind: 'other',
      source: 'upload',
      filename: str(f.originalname, 200) || `${c.number}-document.${ext}`,
      contentType: f.mimetype,
      data: f.buffer,
      size: f.buffer.length,
      sha256,
      note,
      uploadedBy: who(req),
    });
    await logContractEvent({
      contract: c,
      type: 'document_uploaded',
      actor: 'user',
      actorName: who(req),
      message: `Uploaded ${doc.filename}${note ? ` (${note.slice(0, 200)})` : ''}`,
      meta: { documentId: String(doc._id), sha256, size: doc.size },
    });
    res.status(201).json(await detail(c._id));
  })
);

// Stream a stored document: unsigned | signed | certificate (or the full
// kind names), or a document id for 'other' uploads. Never cached.
router.get(
  '/:id/documents/:kind',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    const param = req.params.kind;
    let doc = null;
    const kind = DOCUMENT_ALIASES[param];
    if (kind) {
      const ref = c.documents && c.documents[DOCUMENT_REF[kind]];
      if (ref) doc = await ContractDocument.findOne({ _id: ref, contract: c._id }).lean();
      if (!doc) doc = await ContractDocument.findOne({ contract: c._id, kind }).sort({ createdAt: -1 }).lean();
    } else if (mongoose.isValidObjectId(param)) {
      doc = await ContractDocument.findOne({ _id: param, contract: c._id }).lean();
    }
    if (!doc || !doc.data) throw contractError('not_found', 'Document not found');
    const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
    const filename =
      doc.kind === 'other'
        ? (doc.filename || `${c.number}-document`).replace(/["\\\r\n]/g, '_')
        : `${c.number}-${DOCUMENT_SUFFIX[doc.kind]}.pdf`;
    res.setHeader('Content-Type', doc.contentType || 'application/pdf');
    res.setHeader('Content-Length', data.length);
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(data);
  })
);

// ---------------------------------------------------------------------------
// After signing
// ---------------------------------------------------------------------------

router.post(
  '/:id/set-package',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('set_package', c);
    const note = String((req.body && req.body.note) || '').trim();
    if (!note) throw contractError('validation_failed', 'Add a note saying how the package was confirmed', { field: 'note' });
    await envelopeSync.setPackageManually(c._id, { package: req.body.package, note: note.slice(0, 2000), user: who(req) });
    res.json(await detail(c._id));
  })
);

router.post(
  '/:id/resend-invite',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('resend_invite', c);
    const invite = await portalTokens.inviteContractUsers(c, { actor: 'user', user: who(req), force: true });
    if (!invite.sent && invite.results && invite.results.length && invite.results.every((r) => !r.ok)) {
      if (invite.results.every((r) => r.error === 'smtp_not_configured')) {
        throw contractError('not_configured', 'SMTP is not configured, so the invite could not be sent');
      }
      throw contractError('email_failed', `Invite email failed: ${invite.results.map((r) => `${r.email}: ${r.error || 'failed'}`).join('; ')}`);
    }
    res.json({ invite, ...(await detail(c._id)) });
  })
);

// Manual "upcoming invoice" email now (ignores the toggles: staff asked).
router.post(
  '/:id/send-reminder',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('send_reminder', c);
    const r = await emails.sendContractEmail({ contract: c, kind: 'upcoming_payment', data: {}, force: true, actor: 'user', actorName: who(req) });
    if (!r.ok) throw emailResultError(r);
    // lastRemindedAt only: the per-period claim (lastRemindedPeriodEnd) stays
    // with the worker so the scheduled reminder still goes out.
    await AlarmContract.updateOne({ _id: c._id }, { $set: { 'reminders.lastRemindedAt': new Date() } });
    res.json(await detail(c._id));
  })
);

// The portal pay page (never a Checkout URL: those expire). For phone support.
router.post(
  '/:id/payment-link',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('payment_link', c);
    res.json({ url: emails.payUrl(c._id) });
  })
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

router.post(
  '/:id/cancel',
  handle(async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== 'CANCEL') throw contractError('validation_failed', 'Type CANCEL to confirm', { field: 'confirm' });
    const c = await loadContract(req.params.id);
    assertCan('cancel', c);
    if (!(c.billing && c.billing.subscriptionId)) {
      // Signed but payment never set up: nothing to stop in Stripe.
      await billing.cancelWithoutSubscription(c._id, { reason: str(body.reason, 500), user: who(req) });
    } else {
      await billing.cancelSubscription(c._id, {
        // A first payment still pending (awaiting_payment) has no paid
        // period to run out: end it now.
        atPeriodEnd: c.status === 'awaiting_payment' ? false : body.atPeriodEnd !== false,
        reason: str(body.reason, 500),
        user: who(req),
      });
    }
    res.json(await detail(c._id));
  })
);

// Correct one purchaser's email / phone after signing (a paper contract
// recorded without an email, a typo). The portal account follows the email:
// the new address gets an account and a welcome email, and an address no
// longer on the contract loses access to it.
router.post(
  '/:id/purchasers/:index/contact',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('update_contact', c);
    const i = Number(req.params.index);
    const p = Number.isInteger(i) && (c.purchasers || [])[i];
    if (!p) throw contractError('not_found', 'Purchaser not found');
    const body = req.body || {};
    const email = str(body.email, 254).toLowerCase();
    const phone = str(body.phone, 40);
    if (!EMAIL_RE.test(email)) throw contractError('validation_failed', 'Enter a valid email', { field: 'email' });
    const emailChanged = email !== String(p.email || '').toLowerCase();
    if (!emailChanged && phone === String(p.phone || '')) return res.json(await detail(c._id));

    await AlarmContract.updateOne(
      { _id: c._id },
      { $set: { [`purchasers.${i}.email`]: email, [`purchasers.${i}.phone`]: phone } }
    );
    const fresh = await AlarmContract.findById(c._id).lean();
    await logContractEvent({
      contract: fresh,
      type: 'updated',
      actor: 'user',
      actorName: who(req),
      message: `${p.name || 'Purchaser'}'s contact updated${emailChanged ? ` (email ${p.email || 'none'} → ${email})` : ' (phone)'}`,
      meta: { purchaser: i, field: emailChanged ? 'email' : 'phone' },
    });

    let invite = null;
    if (emailChanged) {
      const keep = portalTokens.portalAccountsFor(fresh).map((a) => a.email);
      await PortalUser.updateMany({ contracts: c._id, email: { $nin: keep } }, { $pull: { contracts: c._id } });
      await portalTokens.upsertPortalUsersForContract(fresh);
      // Never invited (no email before): the normal claim. Already invited:
      // a forced resend, so the new address gets its own personal link.
      if (canPerformSafe('resend_invite', fresh)) {
        invite = await portalTokens.inviteContractUsers(fresh, {
          actor: 'user',
          user: who(req),
          force: Boolean(fresh.portal && fresh.portal.invitedAt),
        });
      }
    }
    res.json({ invite, ...(await detail(c._id)) });
  })
);

router.post(
  '/:id/sync-stripe',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    assertCan('sync_stripe', c);
    const sync = await billing.reconcileContract(c._id, { actor: 'user' });
    res.json({ sync, ...(await detail(c._id)) });
  })
);

// Re-send one payment's email by hand (ignores the toggles and an earlier
// send). body.kind: 'receipt' (default, paid invoices) | 'failure' (open).
router.post(
  '/:id/payments/:paymentId/email',
  handle(async (req, res) => {
    const c = await loadContract(req.params.id);
    if (!mongoose.isValidObjectId(req.params.paymentId)) throw contractError('not_found', 'Payment not found');
    const p = await ContractPayment.findOne({ _id: req.params.paymentId, contract: c._id }).select('_id status').lean();
    if (!p) throw contractError('not_found', 'Payment not found');
    const kind = (req.body && req.body.kind) === 'failure' ? 'failure' : 'receipt';
    const send = kind === 'failure' ? billing.sendFailureForPayment : billing.sendReceiptForPayment;
    const r = await send(p._id, { force: true, actor: 'user', user: who(req) });
    if (!r.ok) throw emailResultError(r);
    res.json(await detail(c._id));
  })
);

module.exports = router;
// Pure helpers, exported for tests.
module.exports.cleanPurchasers = cleanPurchasers;
module.exports.cleanProperty = cleanProperty;
module.exports.purchasersToBuyers = purchasersToBuyers;

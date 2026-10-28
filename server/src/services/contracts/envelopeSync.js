const crypto = require('crypto');
const AlarmContract = require('../../models/AlarmContract');
const ContractDocument = require('../../models/ContractDocument');
const Setting = require('../../models/Setting');
const env = require('../../config/env');
const docusign = require('./docusign');
const signersLib = require('./signers');
const agreementPdf = require('./agreementPdf');
const pricing = require('./pricing');
const eventLogger = require('./eventLogger');
const portalTokens = require('./portalTokens');
const emails = require('./emails');
const { contractError } = require('./errors');
const { ENVELOPE_STATUSES, canAdvanceEnvelope, envelopeStatusesBelow, assertCan } = require('./status');

// Envelope lifecycle — the ONE code path for DocuSign status, used by the
// Connect webhook, the poller and the admin Refresh button, plus the send /
// void / resend actions and the paper-upload tail.
//
// Owner: DocuSign track (tests: contractDocusign.test.js).
//
// Conventions:
//  - always re-fetch the envelope + recipients from DocuSign; the Connect
//    payload is only a hint
//  - envelope.status writes are compare-and-set with
//    status.envelopeStatusesBelow(to); then AlarmContract.refreshStatus(id)
//  - ContractEvents only for real transitions (eventLogger.logContractEvent)
//  - completion is guarded by the envelope.completionClaimedAt claim (stale
//    after 10 min) and finished by setting envelope.completionDoneAt
//
// Collaborators are used through their module objects (docusign.x,
// portalTokens.x, AlarmContract.x …) rather than destructured, so the tests
// can stub them with no database or network.

const CLAIM_STALE_MS = 10 * 60 * 1000;

// Signer (recipient) statuses only move forward too. Declined is final.
const SIGNER_RANK = Object.freeze({
  '': 0,
  created: 1,
  sent: 2,
  autoresponded: 2,
  delivered: 3,
  signed: 4,
  completed: 5,
  declined: 5,
});

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameId(a, b) {
  return String(a) === String(b);
}

function claimFilter(field, now) {
  return { $or: [{ [field]: null }, { [field]: { $lt: new Date(now.getTime() - CLAIM_STALE_MS) } }] };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Pure: what a fresh DocuSign read means for our mirror.
 * @param {object} contract           lean AlarmContract
 * @param {object} envelope           raw GET /envelopes/{id}
 * @param {{signers?: object[]}} recipients raw GET /recipients
 * @returns {{to: string|null, advance: boolean, envelopeSet: object,
 *   purchaserSet: object, signerEvents: Array<{type: string, index: number, name: string, at: Date|null}>,
 *   declinedReason: string}}
 */
function planEnvelopeSync(contract, envelope, recipients) {
  const c = contract || {};
  const e = envelope || {};
  const cur = (c.envelope && c.envelope.status) || null;
  const raw = String(e.status || '').toLowerCase();
  const to = ENVELOPE_STATUSES.includes(raw) ? raw : null;
  const advance = Boolean(to && canAdvanceEnvelope(cur, to));
  const signers = (recipients && recipients.signers) || [];

  // ---- per purchaser ------------------------------------------------------
  const purchaserSet = {};
  const signerEvents = [];
  let declinedReason = '';
  (c.purchasers || []).forEach((p, i) => {
    let r = null;
    if (p.recipientId) r = signers.find((s) => String(s.recipientId) === String(p.recipientId));
    if (!r && p.email) r = signers.find((s) => signersLib.signerKey(s) === signersLib.signerKey(p));
    if (!r) return;
    const st = String(r.status || '').toLowerCase();
    if (r.declinedReason && !declinedReason) declinedReason = String(r.declinedReason);
    const from = p.signStatus || '';
    if (Object.prototype.hasOwnProperty.call(SIGNER_RANK, st) && SIGNER_RANK[st] > (SIGNER_RANK[from] || 0)) {
      purchaserSet[`purchasers.${i}.signStatus`] = st;
      if ((st === 'signed' || st === 'completed') && !(from === 'signed' || from === 'completed')) {
        signerEvents.push({ type: 'recipient_signed', index: i, name: p.name || p.email, at: toDate(r.signedDateTime) });
      }
    }
    const delivered = toDate(r.deliveredDateTime);
    if (delivered && !p.deliveredAt) purchaserSet[`purchasers.${i}.deliveredAt`] = delivered;
    const signed = toDate(r.signedDateTime);
    if (signed && !p.signedAt) purchaserSet[`purchasers.${i}.signedAt`] = signed;
    if (st === 'declined' && r.declinedReason && !p.declinedReason) {
      purchaserSet[`purchasers.${i}.declinedReason`] = String(r.declinedReason).slice(0, 500);
    }
  });

  // ---- envelope ------------------------------------------------------------
  const envelopeSet = {};
  if (advance) {
    envelopeSet['envelope.status'] = to;
    const old = c.envelope || {};
    const sent = toDate(e.sentDateTime);
    if (sent && !old.sentAt) envelopeSet['envelope.sentAt'] = sent;
    const delivered = toDate(e.deliveredDateTime);
    if (delivered && !old.deliveredAt) envelopeSet['envelope.deliveredAt'] = delivered;
    if (to === 'completed') {
      const done = toDate(e.completedDateTime) || toDate(e.statusChangedDateTime) || new Date();
      envelopeSet['envelope.completedAt'] = done;
      if (!c.signedAt) envelopeSet.signedAt = done;
    }
    if (to === 'declined') {
      envelopeSet['envelope.declinedAt'] = toDate(e.declinedDateTime) || toDate(e.statusChangedDateTime) || new Date();
      envelopeSet['envelope.declinedReason'] = declinedReason.slice(0, 500);
    }
    if (to === 'voided') {
      envelopeSet['envelope.voidedAt'] = toDate(e.voidedDateTime) || toDate(e.statusChangedDateTime) || new Date();
      envelopeSet['envelope.voidedReason'] = String(e.voidedReason || '').slice(0, 500);
    }
  }
  return { to, advance, envelopeSet, purchaserSet, signerEvents, declinedReason };
}

const TRANSITION_EVENT = Object.freeze({
  sent: 'sent',
  delivered: 'delivered',
  completed: 'completed',
  declined: 'declined',
  voided: 'voided',
});

function transitionMessage(to, plan, contract) {
  switch (to) {
    case 'delivered':
      return 'Agreement opened by a purchaser';
    case 'declined':
      return `Agreement declined${plan.declinedReason ? `: ${plan.declinedReason}` : ''}`;
    case 'voided':
      return `Envelope voided${plan.envelopeSet['envelope.voidedReason'] ? `: ${plan.envelopeSet['envelope.voidedReason']}` : ''}`;
    case 'sent':
      return `Agreement sent for signature (${(contract.purchasers || []).filter((p) => p.recipientId).length} signer(s))`;
    default:
      return to;
  }
}

/**
 * Sync one envelope from DocuSign and apply it. Never trusts a payload.
 * Unknown envelope → { ignored: 'unknown_envelope' } (still a 200 for Connect).
 * @param {string} envelopeId
 * @param {{actor?: 'docusign'|'docusign_poller'|'user'|'system', actorName?: string}} [opts]
 * @returns {Promise<{ok: boolean, contractId?: string, envelopeStatus?: string, status?: string,
 *   changed?: boolean, completed?: boolean, ignored?: string}>}
 */
async function applyEnvelopeStatus(envelopeId, { actor = 'system', actorName = '' } = {}) {
  if (!envelopeId) return { ok: true, ignored: 'unknown_envelope' };
  const c = await AlarmContract.findOne({ 'envelope.id': String(envelopeId) }).lean();
  if (!c) return { ok: true, ignored: 'unknown_envelope' };

  const [envelope, recipients] = await Promise.all([
    docusign.getEnvelope(envelopeId),
    docusign.getRecipientsWithTabs(envelopeId),
  ]);
  const plan = planEnvelopeSync(c, envelope, recipients);
  const now = new Date();

  let changed = false;
  if (plan.advance) {
    const r = await AlarmContract.updateOne(
      { _id: c._id, 'envelope.id': String(envelopeId), 'envelope.status': { $in: envelopeStatusesBelow(plan.to) } },
      { $set: plan.envelopeSet }
    );
    changed = r.modifiedCount > 0;
  }
  // Signer progress + sync stamp. Not compare-and-set: the values come from
  // the fresh read and only ever move forward (planEnvelopeSync).
  await AlarmContract.updateOne({ _id: c._id }, { $set: { ...plan.purchaserSet, 'envelope.lastSyncedAt': now } });
  const rs = await AlarmContract.refreshStatus(c._id);

  for (const ev of plan.signerEvents) {
    await eventLogger.logContractEvent({
      contract: c,
      type: 'recipient_signed',
      actor,
      actorName,
      message: `${ev.name} signed`,
      meta: { purchaserIndex: ev.index },
    });
  }
  // 'completed' is logged by completeEnvelope once the tail has run, with
  // the chosen package in the message (one milestone, not two).
  if (changed && plan.to !== 'completed') {
    await eventLogger.logContractEvent({
      contract: c,
      type: TRANSITION_EVENT[plan.to] || 'note',
      actor,
      actorName,
      message: transitionMessage(plan.to, plan, c),
      fromStatus: rs.from || c.status || '',
      toStatus: rs.to || '',
      meta: { envelopeId: String(envelopeId), envelopeStatus: plan.to },
    });
    if (plan.to === 'declined' || plan.to === 'voided') {
      const reason = plan.to === 'declined' ? plan.declinedReason : plan.envelopeSet['envelope.voidedReason'];
      await emails.sendAdminAlert({
        contract: c,
        alertKind: plan.to,
        title: `${c.number}: agreement ${plan.to}`,
        lines: [
          `Lot ${(c.property && c.property.lotNumber) || ''} ${(c.property && c.property.projectName) || ''}`.trim(),
          reason ? `Reason: ${reason}` : 'No reason given.',
          'Regenerate the agreement from the contract page to send a new one.',
        ],
      });
    }
  }

  const envelopeStatus = changed ? plan.to : (c.envelope && c.envelope.status) || null;
  let completed = false;
  if (envelopeStatus === 'completed' && !(c.envelope && c.envelope.completionDoneAt)) {
    const done = await completeEnvelope(c._id, { actor, actorName });
    completed = Boolean(done.done);
  }
  return {
    ok: true,
    contractId: String(c._id),
    envelopeStatus,
    status: rs.to || c.status,
    changed,
    completed,
  };
}

// Upsert one DocuSign-sourced document (signed PDF / certificate). The
// partial unique index {contract, envelopeId, kind} makes a second run
// replace rather than duplicate. findOneAndUpdate skips the model's
// pre-validate hook, so `singleton` is set here explicitly.
async function storeEnvelopeDocument({ contract, envelopeId, kind, filename, data }) {
  if (!Buffer.isBuffer(data) || !data.length) throw contractError('envelope_failed', `DocuSign returned an empty ${kind}`);
  if (data.length > ContractDocument.MAX_BYTES) throw contractError('document_too_large', `${kind} is larger than 15 MB`);
  return ContractDocument.findOneAndUpdate(
    { contract: contract._id, envelopeId, kind, singleton: true },
    {
      $set: {
        source: 'docusign',
        filename,
        contentType: 'application/pdf',
        data,
        size: data.length,
        sha256: sha256(data),
      },
      $setOnInsert: { contract: contract._id, envelopeId, kind, singleton: true },
    },
    { upsert: true, new: true, projection: { data: 0 } }
  ).lean();
}

/**
 * Completion tail for a completed envelope (claim-guarded, idempotent):
 * package via docusign.extractPackageChoice (missing → needsAttention
 * 'package_missing' + admin_alert email), store signed PDF + certificate
 * (ContractDocument upserts with sha256), portal users, the welcome email
 * via portalTokens.inviteContractUsers (only when the package is valid), the
 * 'completed' milestone (mirrored to the lot timeline), completionDoneAt.
 * Paper contracts (signingMode 'paper') skip the DocuSign steps.
 *
 * A failure releases the claim and rethrows: completionDoneAt stays null so
 * the next Connect retry or the poller runs the tail again; every step is
 * safe to repeat.
 * @param {string} contractId
 * @param {{actor?: string, actorName?: string}} [opts]
 * @returns {Promise<{done: boolean, skipped?: 'claimed'|'already_done', package?: string|null, needsAttention?: string}>}
 */
async function completeEnvelope(contractId, { actor = 'system', actorName = '' } = {}) {
  const now = new Date();
  const c = await AlarmContract.findOneAndUpdate(
    {
      _id: contractId,
      'envelope.status': 'completed',
      'envelope.completionDoneAt': null,
      ...claimFilter('envelope.completionClaimedAt', now),
    },
    { $set: { 'envelope.completionClaimedAt': now } },
    { new: true }
  ).lean();
  if (!c) {
    const cur = await AlarmContract.findById(contractId).select('envelope.completionDoneAt envelope.status').lean();
    if (!cur) throw contractError('not_found', 'Contract not found');
    return { done: false, skipped: cur.envelope && cur.envelope.completionDoneAt ? 'already_done' : 'claimed' };
  }

  const paper = c.signingMode === 'paper' || !(c.envelope && c.envelope.id);
  const envelopeId = (c.envelope && c.envelope.id) || '';
  try {
    // ---- 1. Package ---------------------------------------------------------
    let pkg = pricing.isValidPackage(c.package) ? c.package : null;
    let needsAttention = c.needsAttention || '';
    if (!pkg && !paper) {
      const recipients = await docusign.getRecipientsWithTabs(envelopeId);
      let choice = docusign.extractPackageChoice({ recipients });
      if (!choice.package) {
        const formData = await docusign.getFormData(envelopeId);
        choice = docusign.extractPackageChoice({ recipients, formData });
      }
      if (choice.package) {
        pkg = choice.package;
        const primary = (recipients.signers || []).find((s) => String(s.recipientId) === '1');
        await AlarmContract.updateOne(
          { _id: c._id },
          {
            $set: {
              package: pkg,
              pricing: pricing.pricingFor(pkg),
              packageChosenAt: toDate(primary && primary.signedDateTime) || (c.envelope && c.envelope.completedAt) || now,
              packageSource: 'docusign',
              needsAttention: '',
            },
          }
        );
        needsAttention = '';
      } else if (needsAttention !== 'package_missing') {
        needsAttention = 'package_missing';
        await AlarmContract.updateOne({ _id: c._id }, { $set: { needsAttention } });
        await eventLogger.logContractEvent({
          contract: c,
          type: 'package_missing',
          actor,
          actorName,
          message: choice.raw
            ? `Signed with an unrecognised package value "${String(choice.raw).slice(0, 40)}"`
            : 'Signed without a monitoring package selection',
          meta: { raw: choice.raw ? String(choice.raw).slice(0, 40) : null },
        });
        await emails.sendAdminAlert({
          contract: c,
          alertKind: 'package_missing',
          title: `${c.number}: signed, but no monitoring package was chosen`,
          lines: [
            `Lot ${(c.property && c.property.lotNumber) || ''} ${(c.property && c.property.projectName) || ''}`.trim(),
            'Set the package on the contract page (an audit note is required). The homeowner welcome email and payment setup wait until then.',
          ],
        });
      }
    }

    // ---- 2. Signed PDF + certificate -----------------------------------------
    if (!paper && !(c.documents && c.documents.signed && c.documents.certificate)) {
      const [signedPdf, certPdf] = await Promise.all([
        docusign.downloadCombined(envelopeId),
        docusign.downloadCertificate(envelopeId),
      ]);
      const base = c.number || String(c._id);
      const signedDoc = await storeEnvelopeDocument({
        contract: c,
        envelopeId,
        kind: 'agreement_signed',
        filename: `${base}-signed.pdf`,
        data: signedPdf,
      });
      const certDoc = await storeEnvelopeDocument({
        contract: c,
        envelopeId,
        kind: 'certificate',
        filename: `${base}-certificate.pdf`,
        data: certPdf,
      });
      await AlarmContract.updateOne(
        { _id: c._id },
        { $set: { 'documents.signed': signedDoc._id, 'documents.certificate': certDoc._id } }
      );
      await eventLogger.logContractEvent({
        contract: c,
        type: 'documents_stored',
        actor,
        actorName,
        message: 'Signed agreement and certificate of completion stored',
        meta: {
          envelopeId,
          signed: { sha256: signedDoc.sha256, size: signedDoc.size },
          certificate: { sha256: certDoc.sha256, size: certDoc.size },
        },
      });
    }

    // ---- 3. Portal accounts + welcome email --------------------------------
    const fresh = await AlarmContract.findById(c._id).lean();
    await portalTokens.upsertPortalUsersForContract(fresh);
    if (pkg && !needsAttention) {
      // Claims portal.invitedAt itself, so a retry never sends twice; email
      // failures are reported per user, never thrown. A send that failed
      // leaves invitedAt null and is retried by workers/contractTailWorker,
      // so completion can be marked done regardless.
      await portalTokens.inviteContractUsers(fresh, { actor, user: actorName });
    }

    // ---- 4. Done (CAS so only one run logs the milestone) -------------------
    const fin = await AlarmContract.updateOne(
      { _id: c._id, 'envelope.completionDoneAt': null },
      { $set: { 'envelope.completionDoneAt': new Date() } }
    );
    const rs = await AlarmContract.refreshStatus(c._id);
    if (fin.modifiedCount > 0 && !paper) {
      await eventLogger.logContractEvent({
        contract: c,
        type: 'completed',
        actor,
        actorName,
        message: pkg
          ? `Monitoring agreement signed – ${pricing.PACKAGES[pkg].label}`
          : 'Monitoring agreement signed – package not selected',
        toStatus: rs.to || '',
        meta: { envelopeId, package: pkg },
      });
    }
    return { done: true, package: pkg, needsAttention };
  } catch (err) {
    // Release our claim so the next trigger can retry straight away.
    await AlarmContract.updateOne(
      { _id: c._id, 'envelope.completionClaimedAt': now },
      { $set: { 'envelope.completionClaimedAt': null } }
    ).catch(() => {});
    throw err;
  }
}

async function loadLean(contractId) {
  const c = await AlarmContract.findById(contractId).lean();
  if (!c) throw contractError('not_found', 'Contract not found');
  return c;
}

/**
 * Send a draft for signature: claim (status draft + envelope.sendClaimedAt
 * null/stale) → buildSigners → renderAgreementForContract → docusign.createEnvelope
 * → set envelope {id, status:'sent', sentAt}, purchasers' recipientId/
 * routingOrder/clientUserId, termsVersion → store ContractDocument
 * agreement_unsigned. Any failure before DocuSign accepts the envelope rolls
 * the claim back and rethrows (contractError codes from signers/docusign).
 * @param {string} contractId
 * @param {{user?: string}} [opts] staff username for the event log
 * @returns {Promise<object>} the updated contract (lean)
 * @throws invalid_state | no_signer_email | not_configured | docusign_consent_required | anchor_missing | envelope_failed
 */
async function sendContract(contractId, { user = '' } = {}) {
  const current = await loadLean(contractId);
  assertCan('send', current);
  if (!env.docusign.dispatchable) throw contractError('not_configured', 'DocuSign is not configured (DOCUSIGN_* in .env)');

  const now = new Date();
  const c = await AlarmContract.findOneAndUpdate(
    {
      _id: current._id,
      status: 'draft',
      signingMode: { $ne: 'paper' },
      'envelope.status': null,
      ...claimFilter('envelope.sendClaimedAt', now),
    },
    { $set: { 'envelope.sendClaimedAt': now } },
    { new: true }
  ).lean();
  if (!c) throw contractError('invalid_state', 'This agreement is already being sent');

  const rollback = () =>
    AlarmContract.updateOne(
      { _id: c._id, 'envelope.sendClaimedAt': now },
      { $set: { 'envelope.sendClaimedAt': null } }
    ).catch(() => {});

  let created;
  let signers;
  let pdf;
  let termsVersion;
  let ccEmail;
  try {
    const setting = await Setting.getSingleton();
    const alarm = (setting && setting.alarm) || {};
    termsVersion = c.termsVersion || alarm.termsVersion || '';
    ccEmail = alarm.contractsCcEmail || '';
    signers = signersLib.buildSigners(c.purchasers, {
      mode: c.signingMode === 'in_person' ? 'in_person' : 'remote',
      contractId: String(c._id),
    });
    pdf = await agreementPdf.renderAgreementForContract({ ...c, termsVersion }, { signers, termsVersion });
    created = await docusign.createEnvelope({ contract: c, pdf, signers, ccEmail });
  } catch (err) {
    // A create that timed out (or got a 5xx) may still have gone through,
    // with DocuSign already emailing the signer. Rolling back to a plain
    // draft would let staff send a second envelope while the homeowner signs
    // the first, whose Connect messages then match no contract. So look for
    // it by our contractId custom field and adopt it if it is out.
    if (err && err.ambiguous) {
      try {
        const found = await docusign.findSentEnvelopesForContract({
          contractId: String(c._id),
          fromDate: new Date(now.getTime() - 10 * 60 * 1000),
        });
        if (found.length) created = found[found.length - 1];
      } catch (lookupErr) {
        console.warn('[docusign] lookup after a failed send failed', lookupErr.message);
        await rollback();
        throw contractError(
          'envelope_failed',
          'DocuSign did not confirm the envelope and it could not be checked. Look in DocuSign before sending again, so the purchaser does not get two agreements.'
        );
      }
    }
    if (!created) {
      await rollback();
      throw err;
    }
    console.warn('[docusign] envelope create timed out but DocuSign has it; adopting', created.envelopeId);
  }

  // DocuSign has the envelope and is emailing signers: from here on, never
  // roll back to a plain draft. If we can't record it, void it so no orphan
  // envelope stays out for signature.
  const set = {
    'envelope.id': created.envelopeId,
    'envelope.status': 'sent',
    'envelope.sentAt': toDate(created.statusDateTime) || new Date(),
    'envelope.sendClaimedAt': null,
    'envelope.completionClaimedAt': null,
    'envelope.completionDoneAt': null,
    termsVersion,
  };
  const signerIdx = new Set();
  for (const s of signers) {
    signerIdx.add(s.purchaserIndex);
    set[`purchasers.${s.purchaserIndex}.recipientId`] = s.recipientId;
    set[`purchasers.${s.purchaserIndex}.routingOrder`] = s.routingOrder;
    set[`purchasers.${s.purchaserIndex}.clientUserId`] = s.clientUserId || '';
    set[`purchasers.${s.purchaserIndex}.signStatus`] = s.routingOrder === 1 ? 'sent' : 'created';
  }
  (c.purchasers || []).forEach((_p, i) => {
    if (signerIdx.has(i)) return;
    set[`purchasers.${i}.recipientId`] = '';
    set[`purchasers.${i}.routingOrder`] = null;
    set[`purchasers.${i}.clientUserId`] = '';
    set[`purchasers.${i}.signStatus`] = '';
  });
  try {
    const r = await AlarmContract.updateOne(
      { _id: c._id, 'envelope.sendClaimedAt': now, 'envelope.status': { $in: envelopeStatusesBelow('sent') } },
      { $set: set }
    );
    if (!r.modifiedCount) throw new Error('send claim lost');
  } catch (err) {
    console.error('[docusign] could not record envelope; voiding it', created.envelopeId, err.message);
    await docusign.voidEnvelope(created.envelopeId, 'Sending failed, a new agreement will follow').catch(() => {});
    await rollback();
    throw contractError('envelope_failed', 'The envelope was created but could not be saved; it has been voided. Try again.');
  }
  const rs = await AlarmContract.refreshStatus(c._id);

  // The unsigned agreement exactly as sent (audit). Best effort: the envelope
  // is already out.
  try {
    const doc = await ContractDocument.findOneAndUpdate(
      { contract: c._id, envelopeId: created.envelopeId, kind: 'agreement_unsigned', singleton: true },
      {
        $set: {
          source: 'generated',
          filename: `${c.number || c._id}-agreement.pdf`,
          contentType: 'application/pdf',
          data: pdf,
          size: pdf.length,
          sha256: sha256(pdf),
          uploadedBy: user,
        },
        $setOnInsert: { contract: c._id, envelopeId: created.envelopeId, kind: 'agreement_unsigned', singleton: true },
      },
      { upsert: true, new: true, projection: { data: 0 } }
    ).lean();
    await AlarmContract.updateOne({ _id: c._id }, { $set: { 'documents.unsigned': doc._id } });
  } catch (err) {
    console.warn('[docusign] could not store the unsigned agreement', err.message);
  }

  const names = signers.map((s) => s.name).join(', ');
  await eventLogger.logContractEvent({
    contract: c,
    type: 'sent',
    actor: 'user',
    actorName: user,
    message:
      c.signingMode === 'in_person'
        ? `Agreement prepared for in-person signing (${names})`
        : `Agreement sent for signature to ${names}`,
    fromStatus: rs.from || 'draft',
    toStatus: rs.to || 'sent',
    meta: { envelopeId: created.envelopeId, signingMode: c.signingMode, signers: signers.length, cc: Boolean(ccEmail) },
  });
  return loadLean(c._id);
}

/**
 * Void a sent envelope (DocuSign + mirror). @throws invalid_state | validation_failed
 * @param {string} contractId
 * @param {{reason: string, user?: string}} opts
 * @returns {Promise<object>} updated contract (lean)
 */
async function voidContract(contractId, { reason, user = '' } = {}) {
  const c = await loadLean(contractId);
  assertCan('void', c);
  const why = String(reason || '').trim();
  if (!why) throw contractError('validation_failed', 'A reason is required to void an agreement', { field: 'reason' });
  try {
    await docusign.voidEnvelope(c.envelope.id, why);
  } catch (err) {
    // Most likely it completed or was declined meanwhile: pull the truth in
    // so the page shows it, then report the original failure.
    await applyEnvelopeStatus(c.envelope.id, { actor: 'user', actorName: user }).catch(() => {});
    throw err;
  }
  const now = new Date();
  const r = await AlarmContract.updateOne(
    { _id: c._id, 'envelope.status': { $in: envelopeStatusesBelow('voided') } },
    { $set: { 'envelope.status': 'voided', 'envelope.voidedAt': now, 'envelope.voidedReason': why.slice(0, 500) } }
  );
  const rs = await AlarmContract.refreshStatus(c._id);
  if (r.modifiedCount) {
    await eventLogger.logContractEvent({
      contract: c,
      type: 'voided',
      actor: 'user',
      actorName: user,
      message: `Envelope voided: ${why}`,
      fromStatus: rs.from || c.status,
      toStatus: rs.to || 'voided',
      meta: { envelopeId: c.envelope.id },
    });
  }
  return loadLean(c._id);
}

/**
 * Re-send the DocuSign signing emails (remote mode). @throws invalid_state
 * @returns {Promise<object>} updated contract (lean)
 */
async function resendContract(contractId, { user = '' } = {}) {
  const c = await loadLean(contractId);
  assertCan('resend', c);
  await docusign.resendEnvelope(c.envelope.id);
  await eventLogger.logContractEvent({
    contract: c,
    type: 'resent',
    actor: 'user',
    actorName: user,
    message: 'Signing email re-sent to purchasers who have not signed yet',
    meta: { envelopeId: c.envelope.id },
  });
  return loadLean(c._id);
}

function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Paper contract: store the uploaded signed PDF (ContractDocument kind
 * agreement_signed, source 'upload'), set signingMode 'paper',
 * envelope.status 'completed' + completedAt = signedAt, package/pricing/
 * packageSource 'paper', then the same tail as completeEnvelope (portal users,
 * welcome email, completionDoneAt). Draft contracts only.
 *
 * The tail runs after the contract is recorded; if it fails (e.g. SMTP down)
 * the upload still stands and the poller retries the tail.
 * @param {string} contractId
 * @param {{pdf: Buffer, filename?: string, package: 'basic'|'smart', signedAt: Date, note?: string, user?: string}} a
 * @returns {Promise<object>} updated contract (lean)
 * @throws invalid_state | invalid_package | document_too_large | invalid_document | validation_failed
 */
async function completePaperSigning(contractId, { pdf, filename, package: pkg, signedAt, note, user = '' } = {}) {
  if (!pricing.isValidPackage(pkg)) throw contractError('invalid_package', 'Choose Basic or Smart monitoring');
  if (!Buffer.isBuffer(pdf) || !pdf.length) throw contractError('invalid_document', 'Upload the signed agreement as a PDF');
  if (pdf.length > ContractDocument.MAX_BYTES) throw contractError('document_too_large', 'The PDF is larger than 15 MB');
  if (!looksLikePdf(pdf)) throw contractError('invalid_document', 'The uploaded file is not a PDF');
  const when = signedAt ? toDate(signedAt) : new Date();
  if (!when) throw contractError('validation_failed', 'Signed date is invalid', { field: 'signedAt' });
  if (when.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw contractError('validation_failed', 'Signed date cannot be in the future', { field: 'signedAt' });
  }

  const current = await loadLean(contractId);
  assertCan('manual_signed', current);

  // Same claim as sending, so a paper upload and a DocuSign send can't race.
  const now = new Date();
  const c = await AlarmContract.findOneAndUpdate(
    { _id: current._id, status: 'draft', 'envelope.status': null, ...claimFilter('envelope.sendClaimedAt', now) },
    { $set: { 'envelope.sendClaimedAt': now } },
    { new: true }
  ).lean();
  if (!c) throw contractError('invalid_state', 'This agreement is being sent; void it before uploading a paper copy');

  const cleanNote = String(note || '').trim().slice(0, 2000);
  let doc;
  try {
    doc = await ContractDocument.findOneAndUpdate(
      { contract: c._id, envelopeId: '', kind: 'agreement_signed', singleton: true },
      {
        $set: {
          source: 'upload',
          filename: String(filename || `${c.number || c._id}-signed.pdf`).slice(0, 200),
          contentType: 'application/pdf',
          data: pdf,
          size: pdf.length,
          sha256: sha256(pdf),
          note: cleanNote,
          uploadedBy: user,
        },
        $setOnInsert: { contract: c._id, envelopeId: '', kind: 'agreement_signed', singleton: true },
      },
      { upsert: true, new: true, projection: { data: 0 } }
    ).lean();

    const set = {
      signingMode: 'paper',
      signedAt: when,
      package: pkg,
      pricing: pricing.pricingFor(pkg),
      packageChosenAt: when,
      packageSource: 'paper',
      needsAttention: '',
      'documents.signed': doc._id,
      'envelope.status': 'completed',
      'envelope.completedAt': when,
      'envelope.sendClaimedAt': null,
      'envelope.completionClaimedAt': null,
      'envelope.completionDoneAt': null,
    };
    (c.purchasers || []).forEach((p, i) => {
      if (p.signs === false) return;
      set[`purchasers.${i}.signStatus`] = 'completed';
      set[`purchasers.${i}.signedAt`] = when;
    });
    const r = await AlarmContract.updateOne(
      { _id: c._id, 'envelope.sendClaimedAt': now, 'envelope.status': { $in: envelopeStatusesBelow('completed') } },
      { $set: set }
    );
    if (!r.modifiedCount) throw contractError('invalid_state', 'The contract changed while uploading; reload and try again');
  } catch (err) {
    await AlarmContract.updateOne(
      { _id: c._id, 'envelope.sendClaimedAt': now },
      { $set: { 'envelope.sendClaimedAt': null } }
    ).catch(() => {});
    throw err;
  }
  const rs = await AlarmContract.refreshStatus(c._id);
  await eventLogger.logContractEvent({
    contract: c,
    type: 'paper_signed',
    actor: 'user',
    actorName: user,
    message: `Signed paper agreement uploaded – ${pricing.PACKAGES[pkg].label}${cleanNote ? ` (${cleanNote.slice(0, 200)})` : ''}`,
    fromStatus: rs.from || 'draft',
    toStatus: rs.to || 'awaiting_payment',
    meta: { documentId: String(doc._id), sha256: doc.sha256, size: doc.size, signedAt: when, package: pkg },
  });

  try {
    await completeEnvelope(c._id, { actor: 'user', actorName: user });
  } catch (err) {
    console.warn('[contracts] paper signing tail failed; the contract tail worker will retry', err.message);
  }
  return loadLean(c._id);
}

/**
 * Alias with the argument names used by the admin route plan:
 * completeManualSigned(contract, {pdfBuffer, package, signedAt, note, actor, filename}).
 * `contract` may be a document, a lean object or an id; `actor` is the staff
 * username.
 */
async function completeManualSigned(contract, { pdfBuffer, pdf, package: pkg, signedAt, note, actor = '', user, filename } = {}) {
  const id = contract && contract._id ? contract._id : contract;
  return completePaperSigning(id, { pdf: pdfBuffer || pdf, filename, package: pkg, signedAt, note, user: user || actor });
}

/**
 * Staff set the package on a package_missing contract (audit note required):
 * package/pricing/packageSource 'admin', clear needsAttention, ContractEvent
 * package_set, then portalTokens.inviteContractUsers (welcome email).
 * @param {string} contractId
 * @param {{package: 'basic'|'smart', note: string, user?: string}} a
 * @returns {Promise<object>} updated contract (lean)
 * @throws invalid_state | invalid_package | validation_failed (missing note)
 */
async function setPackageManually(contractId, { package: pkg, note, user = '' } = {}) {
  if (!pricing.isValidPackage(pkg)) throw contractError('invalid_package', 'Choose Basic or Smart monitoring');
  const why = String(note || '').trim();
  if (!why) throw contractError('validation_failed', 'A note is required when setting the package by hand', { field: 'note' });
  const current = await loadLean(contractId);
  assertCan('set_package', current);
  const c = await AlarmContract.findOneAndUpdate(
    { _id: current._id, needsAttention: 'package_missing' },
    {
      $set: {
        package: pkg,
        pricing: pricing.pricingFor(pkg),
        packageChosenAt: new Date(),
        packageSource: 'admin',
        needsAttention: '',
      },
    },
    { new: true }
  ).lean();
  if (!c) throw contractError('invalid_state', 'The package has already been set');
  await eventLogger.logContractEvent({
    contract: c,
    type: 'package_set',
    actor: 'user',
    actorName: user,
    message: `Package set to ${pricing.PACKAGES[pkg].label}: ${why.slice(0, 300)}`,
    meta: { package: pkg },
  });
  try {
    await portalTokens.inviteContractUsers(c, { actor: 'user', user });
  } catch (err) {
    console.warn('[contracts] welcome email after setting the package failed', err.message);
  }
  return loadLean(c._id);
}

module.exports = {
  setPackageManually,
  applyEnvelopeStatus,
  completeEnvelope,
  sendContract,
  voidContract,
  resendContract,
  completePaperSigning,
  completeManualSigned,
  // pure, exported for tests
  planEnvelopeSync,
  CLAIM_STALE_MS,
};

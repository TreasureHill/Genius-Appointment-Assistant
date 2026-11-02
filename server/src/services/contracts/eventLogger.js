const mongoose = require('mongoose');
const ContractEvent = require('../../models/ContractEvent');
const { logLotEvent } = require('../lotEventLogger');

// Contract history logger — the contract-side twin of services/lotEventLogger.
// Fire-and-forget: the state change it describes has already been persisted,
// so a logging failure is warned about and swallowed, never thrown.
//
// Milestones are also mirrored onto the lot timeline as a LotEvent of type
// 'contract' so Activity and the lot page show "Monitoring agreement signed"
// without reading ContractEvent.

// Contract event types that also appear on the lot timeline (unless the
// caller passes mirror:false; any other type can opt in with mirror:true).
const MILESTONE_TYPES = new Set(['sent', 'completed', 'paper_signed', 'declined', 'voided', 'activated', 'canceled']);

// ContractEvent.actor → LotEvent.actor (the lot enum is coarser).
function lotActorFor(actor) {
  switch (actor) {
    case 'user':
      return 'user';
    case 'docusign':
    case 'docusign_poller':
      return 'docusign';
    case 'stripe':
    case 'stripe_reconciler':
      return 'stripe';
    default:
      return 'contracts';
  }
}

// Accepts a contract document / lean object ({ _id, lot, project, number }) or
// a bare id (then looked up). Returns the ContractEvent (or null on failure).
async function logContractEvent({
  contract,
  type,
  actor = 'system',
  actorName = '',
  message = '',
  fromStatus = '',
  toStatus = '',
  meta,
  mirror,
}) {
  if (!contract || !type) return null;
  try {
    let c = contract;
    const isBareId = typeof c === 'string' || c instanceof mongoose.Types.ObjectId;
    if (isBareId || !c.lot) {
      const AlarmContract = require('../../models/AlarmContract');
      c = await AlarmContract.findById(isBareId ? c : c._id).select('lot project number').lean();
      if (!c) return null;
    }
    const lotId = (c.lot && c.lot._id) || c.lot;
    const projectId = (c.project && c.project._id) || c.project;
    const ev = await ContractEvent.create({
      contract: c._id,
      lot: lotId,
      project: projectId,
      type,
      actor,
      actorName: actorName || '',
      message: message || '',
      fromStatus: fromStatus || '',
      toStatus: toStatus || '',
      meta,
    });
    const shouldMirror = mirror === undefined ? MILESTONE_TYPES.has(type) : Boolean(mirror);
    if (shouldMirror && lotId) {
      await logLotEvent({
        lot: lotId,
        project: projectId,
        type: 'contract',
        fromStatus,
        toStatus,
        actor: lotActorFor(actor),
        message: c.number ? `${c.number}: ${message || type}` : message || type,
      });
    }
    return ev;
  } catch (e) {
    console.warn('[contracts] failed to log contract event', type, e.message);
    return null;
  }
}

module.exports = { logContractEvent, lotActorFor, MILESTONE_TYPES };

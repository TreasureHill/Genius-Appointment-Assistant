const LotEvent = require('../models/LotEvent');

// Tiny convenience wrapper. Fire-and-forget — never block the calling path
// on logging failures (the actual status change has already been persisted).
async function logStatusChange({ lot, project, fromStatus, toStatus, actor, message }) {
  if (!lot || fromStatus === toStatus) return;
  try {
    await LotEvent.create({
      lot: lot._id || lot,
      project: project || (lot.project && lot.project._id) || lot.project,
      type: 'status_change',
      fromStatus: fromStatus || '',
      toStatus: toStatus || '',
      actor: actor || 'system',
      message: message || '',
    });
  } catch (e) {
    console.warn('[lotEventLogger] failed to log status change', e.message);
  }
}

// Any other lot timeline entry: the lot was closed / reopened (type
// 'closing'), or an alarm monitoring contract milestone (type 'contract',
// written by services/contracts/eventLogger). Unlike logStatusChange this
// never skips on from === to — a "signed" milestone has no status pair.
// Same fire-and-forget contract: never throws.
async function logLotEvent({ lot, project, type, fromStatus, toStatus, actor, message }) {
  if (!lot || !type) return;
  try {
    await LotEvent.create({
      lot: lot._id || lot,
      project: project || (lot.project && lot.project._id) || lot.project,
      type,
      fromStatus: fromStatus || '',
      toStatus: toStatus || '',
      actor: actor || 'system',
      message: message || '',
    });
  } catch (e) {
    console.warn('[lotEventLogger] failed to log lot event', e.message);
  }
}

module.exports = { logStatusChange, logLotEvent };

const cron = require('node-cron');
const Lot = require('../models/Lot');
const LotEvent = require('../models/LotEvent');

// Every 15 minutes: flip any 'scheduled' lot whose Calendly appointment has
// already ended over to 'completed'. Uses endTime when set, falls back to
// startTime (so a meeting with no end time recorded still gets reaped once
// its start has passed).
async function runOnce() {
  const now = new Date();
  const due = await Lot.find({
    status: 'scheduled',
    $or: [
      { 'calendlyEvent.endTime': { $ne: null, $lte: now } },
      { 'calendlyEvent.endTime': null, 'calendlyEvent.startTime': { $ne: null, $lte: now } },
    ],
  })
    .select('_id project calendlyEvent.endTime calendlyEvent.startTime')
    .lean();
  if (!due.length) return { completed: 0 };

  const ids = due.map((l) => l._id);
  await Lot.updateMany({ _id: { $in: ids } }, { $set: { status: 'completed' } });

  const events = due.map((l) => {
    const when =
      (l.calendlyEvent && l.calendlyEvent.endTime) ||
      (l.calendlyEvent && l.calendlyEvent.startTime) ||
      null;
    return {
      project: l.project,
      lot: l._id,
      type: 'status_change',
      fromStatus: 'scheduled',
      toStatus: 'completed',
      actor: 'completion_worker',
      message: when
        ? `Appointment ${when.toISOString()} has passed.`
        : 'Appointment time has passed.',
    };
  });
  await LotEvent.insertMany(events, { ordered: false }).catch((e) =>
    console.warn('[completion] event log failed', e.message)
  );

  console.log(`[completion] marked ${due.length} lots completed`);
  return { completed: due.length };
}

function start() {
  cron.schedule('*/15 * * * *', () => {
    runOnce().catch((e) => console.error('[completion]', e));
  });
  console.log('[completion] tracker started (every 15 min)');
}

module.exports = { start, runOnce };

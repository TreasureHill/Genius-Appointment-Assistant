const cron = require('node-cron');
const Lot = require('../models/Lot');

// Every 15 minutes: flip any 'scheduled' lot whose Calendly appointment has
// already ended over to 'completed'. Uses endTime when set, falls back to
// startTime (so a meeting with no end time recorded still gets reaped once
// its start has passed).
async function runOnce() {
  const now = new Date();
  const r = await Lot.updateMany(
    {
      status: 'scheduled',
      $or: [
        { 'calendlyEvent.endTime': { $ne: null, $lte: now } },
        { 'calendlyEvent.endTime': null, 'calendlyEvent.startTime': { $ne: null, $lte: now } },
      ],
    },
    { $set: { status: 'completed' } }
  );
  const completed = r.modifiedCount || r.nModified || 0;
  if (completed) console.log(`[completion] marked ${completed} lots completed`);
  return { completed };
}

function start() {
  cron.schedule('*/15 * * * *', () => {
    runOnce().catch((e) => console.error('[completion]', e));
  });
  console.log('[completion] tracker started (every 15 min)');
}

module.exports = { start, runOnce };

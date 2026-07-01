const cron = require('node-cron');
const Lot = require('../models/Lot');

// Safety net for a dropped ElevenLabs post-call webhook: any lot left at
// call.status='calling' longer than TIMEOUT_MIN almost certainly had its
// completion webhook lost. Flip it to 'failed' so the UI stops showing a
// perpetual "calling…" spinner and the operator can retry.
const TIMEOUT_MIN = 30;

async function runOnce(now = new Date()) {
  const cutoff = new Date(now.getTime() - TIMEOUT_MIN * 60 * 1000);
  const res = await Lot.updateMany(
    { 'call.status': 'calling', 'call.startedAt': { $ne: null, $lte: cutoff } },
    {
      $set: {
        'call.status': 'failed',
        'call.outcome': 'failed',
        'call.endedAt': now,
        'call.summary': 'Call timed out — no completion webhook received from ElevenLabs.',
      },
    }
  );
  const n = res.modifiedCount || 0;
  if (n) console.log(`[stuck-call] force-failed ${n} stuck call${n === 1 ? '' : 's'}`);
  return { failed: n };
}

function start() {
  cron.schedule('*/10 * * * *', () => {
    runOnce().catch((e) => console.error('[stuck-call]', e));
  });
  console.log('[stuck-call] janitor started (every 10 min)');
}

module.exports = { start, runOnce };

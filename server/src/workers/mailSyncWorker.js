const { syncAll } = require('../services/mail/sync');

// Keeps the unified inbox current: every minute, each connected mailbox that
// is due (≥45 s since its last sync; failing ones back off 5 min; ones that
// need a reconnect wait for it) runs an incremental sync.
let timer = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await syncAll({ trigger: 'auto' });
  } catch (err) {
    console.error('[mail] sync tick failed:', err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  setTimeout(tick, 5_000);
  timer = setInterval(tick, 60_000);
  console.log('[mail] inbox sync worker started (every 60 s)');
}

module.exports = { start, tick };

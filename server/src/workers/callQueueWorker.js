const callQueue = require('../services/callQueue');
const ariaCall = require('../services/ariaCall');

// Drives the sequential call queue every 20s. First it reconciles ANY call
// still marked 'calling' (manual or queued) by polling ElevenLabs for the
// finished conversation — the safety net for when the post-call webhook isn't
// configured or was dropped. Then it dials the next queued lot when the line is
// free. The webhook also nudges advance() for near-instant hand-off.
const TICK_MS = 20_000;

async function tick() {
  try {
    await ariaCall.reconcileCallingLots();
  } catch (e) {
    console.warn('[call-queue] reconcile failed', e.message);
  }
  try {
    await callQueue.advance();
  } catch (e) {
    console.warn('[call-queue] advance failed', e.message);
  }
}

function start() {
  setInterval(() => {
    tick().catch((e) => console.error('[call-queue]', e));
  }, TICK_MS);
  console.log('[call-queue] worker started (every 20s)');
}

module.exports = { start, tick };

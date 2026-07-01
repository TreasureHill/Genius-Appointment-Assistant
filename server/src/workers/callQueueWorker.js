const callQueue = require('../services/callQueue');

// Drives the sequential call queue every 20s: reconciles the in-flight call
// (poll fallback for a missing webhook) and dials the next queued lot when the
// line is free. The post-call webhook also nudges advance() for near-instant
// hand-off; this tick is the safety net.
const TICK_MS = 20_000;

async function tick() {
  try {
    await callQueue.reconcileActive();
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

const express = require('express');
const callQueue = require('../services/callQueue');

const router = express.Router();

// Current queue snapshot for the Board panel.
router.get('/queue', async (req, res) => {
  res.json(await callQueue.getStatus());
});

// Queue selected lots for sequential Aria calls.
router.post('/queue', async (req, res) => {
  const { lotIds, buyerRole } = req.body || {};
  if (!Array.isArray(lotIds) || lotIds.length === 0) {
    return res.status(400).json({ error: 'lotIds_required' });
  }
  const result = await callQueue.enqueue(lotIds, { buyerRole });
  // Kick the queue immediately so the first call starts without waiting for the
  // worker tick. Best-effort — the worker will pick it up regardless.
  callQueue.advance().catch(() => {});
  const status = await callQueue.getStatus();
  res.json({ ...result, status });
});

// Cancel everything still queued (leaves the in-flight call running).
router.delete('/queue', async (req, res) => {
  const result = await callQueue.clear();
  res.json({ ...result, status: await callQueue.getStatus() });
});

module.exports = router;

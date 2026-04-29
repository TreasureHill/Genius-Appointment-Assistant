const express = require('express');
const Project = require('../models/Project');
const Lot = require('../models/Lot');
const MessageLog = require('../models/MessageLog');
const Outbox = require('../models/Outbox');
const ImportBatch = require('../models/ImportBatch');
const CalendlyUnmatch = require('../models/CalendlyUnmatch');

const router = express.Router();

const WIPE_TOKEN = 'WIPE EVERYTHING';

router.post('/wipe', async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== WIPE_TOKEN) {
    return res.status(400).json({ error: 'confirmation_required', expected: WIPE_TOKEN });
  }
  const [outbox, msg, lots, batches, unmatched, projects] = await Promise.all([
    Outbox.deleteMany({}),
    MessageLog.deleteMany({}),
    Lot.deleteMany({}),
    ImportBatch.deleteMany({}),
    CalendlyUnmatch.deleteMany({}),
    Project.deleteMany({}),
  ]);
  res.json({
    ok: true,
    deleted: {
      projects: projects.deletedCount || 0,
      lots: lots.deletedCount || 0,
      outbox: outbox.deletedCount || 0,
      messageLogs: msg.deletedCount || 0,
      importBatches: batches.deletedCount || 0,
      calendlyUnmatched: unmatched.deletedCount || 0,
    },
  });
});

module.exports = router;

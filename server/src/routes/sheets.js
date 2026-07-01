const express = require('express');
const multer = require('multer');
const Lot = require('../models/Lot');
const ImportBatch = require('../models/ImportBatch');
const { buildBlankTemplate, buildExport } = require('../services/sheetExporter');
const sheetParser = require('../services/sheetParser');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/template', (req, res) => {
  const buf = buildBlankTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="genius-contacts-template.xlsx"');
  res.send(buf);
});

router.get('/export', async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  const lots = await Lot.find(filter).populate('project', 'name').lean();
  const buf = buildExport(lots);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="genius-contacts-export.xlsx"');
  res.send(buf);
});

router.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  try {
    const summary = await sheetParser.preview(req.file.buffer);
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const updateExisting = req.query.update === 'true' || req.body?.update === 'true';
  let marketingNames = {};
  if (req.body?.marketingNames) {
    try {
      marketingNames = JSON.parse(req.body.marketingNames);
    } catch {
      /* ignore malformed — validation below will require them */
    }
  }
  try {
    const result = await sheetParser.commit(req.file.buffer, {
      updateExisting,
      filename: req.file.originalname || '',
      marketingNames,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code, projects: err.projects });
  }
});

router.get('/imports', async (req, res) => {
  const rows = await ImportBatch.find({})
    .populate('createdProjects', 'name')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json(rows);
});

router.post('/imports/:id/revert', async (req, res) => {
  try {
    const result = await sheetParser.revert(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

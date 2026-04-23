const express = require('express');
const multer = require('multer');
const Lot = require('../models/Lot');
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
  const lots = await Lot.find(filter).populate('project', 'name').populate('assignedRep', 'name').lean();
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
  try {
    const result = await sheetParser.commit(req.file.buffer, { updateExisting });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

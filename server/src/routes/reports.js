const express = require('express');
const Lot = require('../models/Lot');
const Project = require('../models/Project');
const { buildStatusReport } = require('../services/sheetExporter');

const router = express.Router();

async function gatherReport(projectId) {
  const projectFilter = projectId ? { _id: projectId } : {};
  const perProject = await Project.aggregate([
    { $match: projectFilter },
    {
      $lookup: {
        from: 'lots',
        localField: '_id',
        foreignField: 'project',
        as: 'lots',
      },
    },
    {
      $project: {
        name: 1,
        totalLots: { $size: '$lots' },
        byStatus: {
          pending: {
            $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'pending'] } } },
          },
          contacted: {
            $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'contacted'] } } },
          },
          scheduled: {
            $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'scheduled'] } } },
          },
          opted_out: {
            $size: { $filter: { input: '$lots', cond: { $eq: ['$$this.status', 'opted_out'] } } },
          },
        },
      },
    },
    { $sort: { name: 1 } },
  ]);

  const lotFilter = projectId ? { project: projectId } : {};
  const lots = await Lot.find(lotFilter)
    .populate('project', 'name')
    .sort({ 'project.name': 1, lotNumber: 1 })
    .lean();

  return { perProject, lots };
}

router.get('/projects-by-status', async (req, res) => {
  const { perProject, lots } = await gatherReport(req.query.project || null);
  res.json({
    perProject,
    totals: lots.reduce(
      (acc, l) => {
        acc.total += 1;
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
      },
      { total: 0 }
    ),
    generatedAt: new Date().toISOString(),
  });
});

router.get('/projects-by-status/export', async (req, res) => {
  const { perProject, lots } = await gatherReport(req.query.project || null);
  const buf = buildStatusReport(perProject, lots);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="genius-status-report-${stamp}.xlsx"`
  );
  res.send(buf);
});

module.exports = router;

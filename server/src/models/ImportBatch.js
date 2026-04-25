const mongoose = require('mongoose');

// Records a single sheet upload so it can be reverted. We track new projects
// and new lots we created, and the previous buyers/address for any lots we
// overwrote when updateExisting was true.
const ImportBatchSchema = new mongoose.Schema(
  {
    filename: { type: String, default: '' },
    updateExisting: { type: Boolean, default: false },
    totalRows: { type: Number, default: 0 },
    createdProjects: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
    createdLots: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lot' }],
    updatedLotSnapshots: [
      {
        lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lot' },
        prev: { type: mongoose.Schema.Types.Mixed, default: {} },
      },
    ],
    warnings: [{ type: String }],
    status: {
      type: String,
      enum: ['committed', 'reverted', 'partially_reverted'],
      default: 'committed',
      index: true,
    },
    revertedAt: { type: Date, default: null },
    revertNote: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ImportBatch', ImportBatchSchema);

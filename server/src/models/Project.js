const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    // Customer-facing name Aria speaks on calls (e.g. "Union Village") when the
    // internal `name` is an operational label ("Bowmanville - Lot Tracking").
    // Falls back to `name` when blank. Surfaced to the agent as {project_name}.
    marketingName: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    defaultEmailTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    defaultSmsTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', ProjectSchema);

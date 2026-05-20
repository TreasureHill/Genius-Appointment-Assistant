const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    defaultEmailTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    defaultSmsTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', ProjectSchema);

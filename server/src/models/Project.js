const mongoose = require('mongoose');
const env = require('../config/env');

const ProjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    reminderIntervalDays: { type: Number, default: env.defaults.reminderDays, min: 0 },
    maxReminders: { type: Number, default: env.defaults.maxReminders, min: 0 },
    pacing: {
      minSec: { type: Number, default: env.defaults.pacingMin, min: 0 },
      maxSec: { type: Number, default: env.defaults.pacingMax, min: 0 },
    },
    quietHours: {
      enabled: { type: Boolean, default: false },
      start: { type: String, default: '21:00' },
      end: { type: String, default: '08:00' },
    },
    defaultEmailTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
    defaultSmsTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', ProjectSchema);

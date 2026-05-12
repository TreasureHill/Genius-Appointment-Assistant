const mongoose = require('mongoose');
const env = require('../config/env');

const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    owner: {
      name: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
      calendlyUri: { type: String, default: '' },
      calendlyUrl: { type: String, default: '' },
    },
    // Global sending schedule (single-owner system, applies across all projects)
    schedule: {
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
      defaultEmailTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
      defaultSmsTemplate: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', default: null },
    },
    smtpHealth: {
      ok: { type: Boolean, default: false },
      checkedAt: { type: Date, default: null },
      message: { type: String, default: '' },
    },
    twilioHealth: {
      ok: { type: Boolean, default: false },
      checkedAt: { type: Date, default: null },
      message: { type: String, default: '' },
    },
    calendlyHealth: {
      ok: { type: Boolean, default: false },
      checkedAt: { type: Date, default: null },
      message: { type: String, default: '' },
    },
    lastCalendlySync: { type: Date, default: null },
    senderPaused: { type: Boolean, default: false },
    remindersPaused: { type: Boolean, default: false },
    emailHighImportance: { type: Boolean, default: false },
  },
  { timestamps: true }
);

SettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'singleton' });
  if (!doc) doc = await this.create({ key: 'singleton' });
  return doc;
};

module.exports = mongoose.model('Setting', SettingSchema);

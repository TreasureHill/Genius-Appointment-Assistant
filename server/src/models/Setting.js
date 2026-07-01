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
      // Legacy "quiet hours" — replaced by sendWindows below. Kept on the
      // schema so older documents don't lose data on read, but the sender
      // worker no longer consults it.
      quietHours: {
        enabled: { type: Boolean, default: false },
        start: { type: String, default: '21:00' },
        end: { type: String, default: '08:00' },
      },
      // Per-day-of-week send windows. Reminders + queued sends only fire when
      // the current weekday's window is enabled and the time falls inside it.
      // Outside the window, sends defer to the next open window.
      sendWindows: {
        monday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '09:00' },
          end: { type: String, default: '21:00' },
        },
        tuesday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '09:00' },
          end: { type: String, default: '21:00' },
        },
        wednesday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '09:00' },
          end: { type: String, default: '21:00' },
        },
        thursday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '09:00' },
          end: { type: String, default: '21:00' },
        },
        friday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '09:00' },
          end: { type: String, default: '21:00' },
        },
        saturday: {
          enabled: { type: Boolean, default: true },
          start: { type: String, default: '10:00' },
          end: { type: String, default: '18:00' },
        },
        sunday: {
          enabled: { type: Boolean, default: false },
          start: { type: String, default: '10:00' },
          end: { type: String, default: '18:00' },
        },
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
    // Aria — the ElevenLabs voice agent that calls homeowners. Agent id /
    // phone-number id / API key live in .env (secrets); everything editable
    // in the UI lives here.
    aria: {
      // Calendly Event Type URI Aria offers over the phone
      // (https://api.calendly.com/event_types/XXXX). Falls back to
      // CALENDLY_EVENT_TYPE_URI when blank.
      calendlyEventTypeUri: { type: String, default: '' },
      // IANA timezone used to speak/label slot times to the homeowner.
      timezone: { type: String, default: 'America/New_York' },
      // Optional per-call overrides pushed to ElevenLabs. Support {first_name},
      // {project_name}, {available_slots}, etc. (substituted server-side).
      firstMessage: { type: String, default: '' },
      systemPrompt: { type: String, default: '' },
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

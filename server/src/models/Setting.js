const mongoose = require('mongoose');

const SettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
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
  },
  { timestamps: true }
);

SettingSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'singleton' });
  if (!doc) doc = await this.create({ key: 'singleton' });
  return doc;
};

module.exports = mongoose.model('Setting', SettingSchema);

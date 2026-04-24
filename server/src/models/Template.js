const mongoose = require('mongoose');

const TemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['email', 'sms'], required: true, index: true },
    subject: { type: String, default: '' },
    bodyHtml: { type: String, default: '' },
    bodyText: { type: String, default: '' },
    isDefaultReminder: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', TemplateSchema);

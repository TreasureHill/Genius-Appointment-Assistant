const mongoose = require('mongoose');

const RepSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    calendlyUser: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

RepSchema.index({ name: 1 });

module.exports = mongoose.model('Rep', RepSchema);

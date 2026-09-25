const mongoose = require('mongoose');

// A rep = one of our own people a Google review can be credited to (the
// Genius technicians: Jason, Salman, Alvee, …). `aliases` are the words the
// classifier looks for in review text (whole-word, case-insensitive); the
// user can also map a review to a rep by hand from the Reviews tab.
const REP_COLORS = ['#4f46e5', '#0ea5e9', '#d97706', '#059669', '#db2777', '#7c3aed', '#dc2626', '#0d9488'];

const RepSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    role: { type: String, default: 'Genius technician', trim: true },
    aliases: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    // Badge colour in the UI; assigned round-robin from REP_COLORS on create.
    color: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Lower-case, trimmed, de-duplicated aliases; the rep's own name is always
// one of them so "Jason" matches without listing it twice.
RepSchema.statics.normalizeAliases = function (name, aliases) {
  const out = [];
  const seen = new Set();
  const list = [name, ...(Array.isArray(aliases) ? aliases : String(aliases || '').split(','))];
  for (const raw of list) {
    const a = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
};

RepSchema.statics.COLORS = REP_COLORS;

module.exports = mongoose.model('Rep', RepSchema);

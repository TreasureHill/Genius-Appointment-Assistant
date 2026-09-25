const mongoose = require('mongoose');

// One Google review of the listing, normalised across sources (SerpApi today,
// Google Business Profile API or a JSON import later).
//
// Classification has two layers:
//   auto   — what the alias / Genius-term matcher found (recomputed on every
//            sync and whenever reps or terms change)
//   manual — the user's override from the Reviews tab: which reps the review
//            really belongs to (`repsSet` distinguishes "cleared to nobody"
//            from "no override") and/or a forced Genius yes / no.
// `reps`, `genius` and `mappingSource` are the EFFECTIVE values (manual wins),
// denormalised so list filters are plain Mongo queries.
const ObjectId = mongoose.Schema.Types.ObjectId;

const ReviewSchema = new mongoose.Schema(
  {
    reviewId: { type: String, required: true, unique: true },
    source: { type: String, enum: ['serpapi', 'gbp', 'import', 'manual'], default: 'serpapi' },
    reviewer: { type: String, default: 'Anonymous' },
    reviewerLink: { type: String, default: '' },
    reviewerAvatar: { type: String, default: '' },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    text: { type: String, default: '' },
    // When it was posted, when it was last edited (== postedAt if never), and
    // the date the review counts for (the last edit — how the manual weekly log
    // treated "Edited 5 days ago" reviews).
    postedAt: { type: Date, required: true, index: true },
    editedAt: { type: Date, required: true },
    effectiveAt: { type: Date, required: true, index: true },
    link: { type: String, default: '' },
    likes: { type: Number, default: 0 },
    reply: {
      text: { type: String, default: '' },
      at: { type: Date, default: null },
    },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },

    auto: {
      reps: { type: [ObjectId], ref: 'Rep', default: [] },
      // Which aliases / Genius terms matched, for the "why is this tagged" hint.
      aliases: { type: [String], default: [] },
      terms: { type: [String], default: [] },
      termHit: { type: Boolean, default: false },
      genius: { type: Boolean, default: false },
    },
    manual: {
      repsSet: { type: Boolean, default: false },
      reps: { type: [ObjectId], ref: 'Rep', default: [] },
      genius: { type: Boolean, default: null },
      note: { type: String, default: '' },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: String, default: '' },
    },

    reps: { type: [ObjectId], ref: 'Rep', default: [], index: true },
    genius: { type: Boolean, default: false, index: true },
    mappingSource: { type: String, enum: ['auto', 'manual'], default: 'auto' },
  },
  { timestamps: true }
);

ReviewSchema.index({ genius: 1, effectiveAt: -1 });
ReviewSchema.index({ rating: 1, effectiveAt: -1 });

module.exports = mongoose.model('Review', ReviewSchema);

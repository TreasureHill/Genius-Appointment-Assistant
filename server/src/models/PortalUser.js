const mongoose = require('mongoose');

// Homeowner login for the /portal pages. Entirely separate from admin `User`:
// own collection, own cookie (psid), own JWT audience (see
// middleware/portalAuth.js). One per unique email; a couple sharing an inbox
// shares one PortalUser, linked to every contract they signed.
const PortalUserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, default: '' },
    // bcryptjs (cost 12). Empty until the invite link is used.
    passwordHash: { type: String, default: '' },
    contracts: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AlarmContract' }], default: [], index: true },
    // One live single-use token at a time (invite = set password, 7 days;
    // reset = forgot password, 1 hour). Only the sha256 hex is stored.
    tokenHash: { type: String, default: null, index: { sparse: true } },
    tokenPurpose: { type: String, enum: ['invite', 'reset', null], default: null },
    tokenExpiresAt: { type: Date, default: null },
    // Embedded in the session JWT as `pv`; bumped on every password set/reset,
    // which logs out every existing session.
    tokenVersion: { type: Number, default: 0 },
    passwordSetAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    disabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PortalUser', PortalUserSchema);

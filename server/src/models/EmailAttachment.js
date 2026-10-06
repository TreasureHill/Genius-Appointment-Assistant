const mongoose = require('mongoose');

// Attachment of a stored message. IMAP attachments are cached at sync time
// (up to the size cap); Microsoft ones are fetched from Graph on first
// download / render and cached then.
const EmailAttachmentSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'MailAccount', required: true },
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailMessage', required: true, index: true },
    filename: { type: String, default: 'attachment' },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    contentId: { type: String, default: '' },
    inline: { type: Boolean, default: false },
    // Graph attachment id, when the bytes live in Microsoft 365.
    remoteId: { type: String, default: '' },
    data: { type: Buffer, default: null },
    // True when the file was over the cache cap and couldn't be kept.
    tooLarge: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailAttachment', EmailAttachmentSchema);

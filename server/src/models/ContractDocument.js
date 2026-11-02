const mongoose = require('mongoose');

// PDFs belonging to an alarm monitoring contract, stored in Mongo as a Buffer.
// Not on disk: deploy.ps1 runs `git reset --hard` in the repo and treats the
// box as disposable, and these are legal records (they are now part of the
// Mongo backups). Files are small (< 2 MB), so GridFS isn't needed; 15 MB is a
// hard cap. Never served statically — only through the authenticated admin /
// portal download routes. List queries must use .select('-data').
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const DOCUMENT_KINDS = ['agreement_unsigned', 'agreement_signed', 'certificate', 'other'];

const ContractDocumentSchema = new mongoose.Schema(
  {
    contract: { type: mongoose.Schema.Types.ObjectId, ref: 'AlarmContract', required: true, index: true },
    // DocuSign envelope the file belongs to ('' for paper uploads / other).
    envelopeId: { type: String, default: '' },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    // generated = our pdfkit agreement; docusign = downloaded after signing;
    // upload = staff uploaded it (paper contract or an extra file).
    source: { type: String, enum: ['generated', 'docusign', 'upload'], default: 'generated' },
    filename: { type: String, default: '' },
    contentType: { type: String, default: 'application/pdf' },
    data: { type: Buffer, required: true },
    size: { type: Number, required: true, max: MAX_DOCUMENT_BYTES },
    sha256: { type: String, required: true },
    note: { type: String, default: '' },
    uploadedBy: { type: String, default: '' },
    // Set automatically: true for the one-per-envelope kinds (everything but
    // 'other'), which makes the partial unique index below apply. A second
    // completion run therefore upserts instead of duplicating, while any
    // number of 'other' uploads can coexist.
    singleton: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ContractDocumentSchema.pre('validate', function setSingleton(next) {
  this.singleton = this.kind !== 'other';
  next();
});

ContractDocumentSchema.index(
  { contract: 1, envelopeId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { singleton: true }, name: 'one_per_envelope_kind' }
);

ContractDocumentSchema.statics.MAX_BYTES = MAX_DOCUMENT_BYTES;
ContractDocumentSchema.statics.KINDS = DOCUMENT_KINDS;

module.exports = mongoose.model('ContractDocument', ContractDocumentSchema);

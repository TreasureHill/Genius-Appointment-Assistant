// Shared error vocabulary for the alarm monitoring contract services. Services
// throw `contractError(code, message, extra)`; the admin and portal routes map
// err.code → HTTP status through CONTRACT_ERROR_HTTP (the same idea as
// CALL_ERROR_HTTP in routes/lots.js) so every track speaks the same codes.

const CONTRACT_ERROR_HTTP = {
  // Generic
  not_implemented: 501,
  not_configured: 503,
  not_found: 404,
  invalid_state: 409,
  validation_failed: 400,
  // Lot / contract setup
  lot_not_closed: 400,
  contract_exists: 409,
  contract_in_progress: 409,
  no_signer_email: 400,
  invalid_package: 400,
  package_missing: 409,
  document_too_large: 413,
  invalid_document: 400,
  // DocuSign
  docusign_consent_required: 409,
  docusign_auth_failed: 502,
  anchor_missing: 502,
  envelope_failed: 502,
  not_your_turn: 409,
  // Stripe
  already_subscribed: 409,
  stripe_catalog_mismatch: 503,
  no_customer: 409,
  no_portal_user: 409,
  // Portal auth
  invalid_credentials: 401,
  account_locked: 423,
  invalid_token: 400,
  weak_password: 400,
  // Outbound email (SMTP rejected or failed a send the admin asked for)
  email_failed: 502,
};

// Build an Error carrying a stable `code` (and the matching HTTP `status`).
// `extra` is merged onto the error — e.g. { consentUrl } for
// docusign_consent_required, { problems } for stripe_catalog_mismatch.
function contractError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.status = CONTRACT_ERROR_HTTP[code] || 500;
  Object.assign(err, extra);
  return err;
}

// Placeholder body for functions whose owning track hasn't landed yet.
function notImplemented(name) {
  return contractError('not_implemented', `${name} is not implemented yet`);
}

// Map an error to { status, body } for a JSON response. Known codes keep their
// code as `error`; unknown errors become a 502 with a short description (never
// a stack, never request bodies or headers). Extra public fields
// (consentUrl, problems, retryAfter) are passed through when present.
function httpErrorFor(err) {
  const code = err && err.code;
  if (code && CONTRACT_ERROR_HTTP[code]) {
    const body = { error: code, message: err.message || code };
    for (const k of ['consentUrl', 'problems', 'retryAfter', 'field']) {
      if (err[k] !== undefined) body[k] = err[k];
    }
    return { status: CONTRACT_ERROR_HTTP[code], body };
  }
  if (err && err.code === 11000) return { status: 409, body: { error: 'contract_exists', message: 'Duplicate record' } };
  if (err && err.name === 'ValidationError') return { status: 400, body: { error: 'validation_failed', message: err.message } };
  if (err && err.name === 'CastError') return { status: 404, body: { error: 'not_found', message: 'Not found' } };
  return { status: 502, body: { error: 'upstream_error', message: (err && err.message) || 'Request failed' } };
}

// Express helper: res.status(..).json(..) from any thrown error.
function sendError(res, err) {
  const { status, body } = httpErrorFor(err);
  if (status >= 500) console.error('[contracts]', body.error, err && err.message);
  return res.status(status).json(body);
}

module.exports = { CONTRACT_ERROR_HTTP, contractError, notImplemented, httpErrorFor, sendError };

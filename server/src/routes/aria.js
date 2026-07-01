// Public server-tool endpoints the ElevenLabs agent ("Aria") calls DURING a
// live call to read Calendly availability and book a slot. Mounted before the
// auth middleware because ElevenLabs' servers hit these directly — they're
// guarded instead by a shared secret (ARIA_TOOL_SECRET) presented as the
// `x-aria-secret` header (or `?secret=` fallback), which you configure on each
// tool in the ElevenLabs agent's Tools panel.
//
// Every response is a 200 with a spoken-friendly `message`, even for failures,
// so the agent can read something sensible to the homeowner instead of hitting
// a tool error.

const express = require('express');
const env = require('../config/env');
const ariaCall = require('../services/ariaCall');

const router = express.Router();

function checkSecret(req, res, next) {
  const secret = env.aria.toolSecret;
  if (!secret) {
    // Dev / not-yet-configured: accept but make the risk visible in logs.
    console.warn('[aria] tool call accepted without ARIA_TOOL_SECRET set — set it in production');
    return next();
  }
  const provided = req.get('x-aria-secret') || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: 'bad_secret' });
  return next();
}

// The agent may send the lot id under a few names depending on how the tool
// parameter is wired up; accept the common spellings.
function lotIdFrom(body) {
  return body.lot_id || body.lotId || body.leadId || body.lead_id || '';
}

// POST /api/aria/tools/availability → { available, slots:[{start_time,label}], message }
router.post('/tools/availability', checkSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ariaCall.getAvailability({ limit: Number(body.limit) || 6 });
    res.json(result);
  } catch (err) {
    res.json({ available: false, slots: [], message: 'I’m having trouble reading the calendar right now.', error: err.message });
  }
});

// POST /api/aria/tools/book → { booked, start_time, label, message }
router.post('/tools/book', checkSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ariaCall.bookAppointment({
      lotId: lotIdFrom(body),
      startTime: body.start_time || body.startTime || body.time || '',
      buyerName: body.buyer_name || body.name || '',
      buyerEmail: body.buyer_email || body.email || '',
      buyerPhone: body.buyer_phone || body.phone || '',
    });
    res.json(result);
  } catch (err) {
    res.json({ booked: false, message: 'Something went wrong booking that time.', error: err.message });
  }
});

module.exports = router;

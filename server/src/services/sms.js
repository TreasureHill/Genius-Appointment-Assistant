const env = require('../config/env');

let twilioClient = null;

function getClient() {
  if (!env.twilio.configured) return null;
  if (twilioClient) return twilioClient;
  const twilio = require('twilio');
  twilioClient = twilio(env.twilio.sid, env.twilio.token);
  return twilioClient;
}

async function verifyTwilio() {
  const c = getClient();
  if (!c) return { ok: false, message: 'Twilio not configured' };
  try {
    const acct = await c.api.accounts(env.twilio.sid).fetch();
    return { ok: true, message: `Twilio account ${acct.friendlyName} (${acct.status})` };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

async function sendSms({ to, body }) {
  const c = getClient();
  if (!c) throw new Error('Twilio not configured');
  const msg = await c.messages.create({
    from: env.twilio.from,
    to,
    body,
  });
  return { messageId: msg.sid };
}

function segmentCount(body = '') {
  const len = body.length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

module.exports = { getClient, verifyTwilio, sendSms, segmentCount };

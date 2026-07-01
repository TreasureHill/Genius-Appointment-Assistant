const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');

const BASE = 'https://api.elevenlabs.io/v1';

function client() {
  if (!env.elevenlabs.apiKey) return null;
  return axios.create({
    baseURL: BASE,
    headers: { 'xi-api-key': env.elevenlabs.apiKey },
    timeout: 20_000,
  });
}

// Can we reach the API at all? (health display)
function isConfigured() {
  return Boolean(env.elevenlabs.apiKey);
}

// Do we have everything needed to actually place a call?
function isDispatchable() {
  return Boolean(
    env.elevenlabs.apiKey && env.elevenlabs.agentId && env.elevenlabs.agentPhoneNumberId
  );
}

// Best-effort coercion to the E.164 shape ElevenLabs/Twilio expect. Buyer
// phones are stored as free text in this app, so a US 10-digit number gets a
// +1, an 11-digit 1-lead gets a +, and anything already starting with + is
// left alone. Non-North-American numbers should be entered with their +country
// code already; we don't guess those.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

// Replace {variable} placeholders server-side. ElevenLabs only resolves a
// placeholder when the variable is declared on the agent, and an unresolved
// {name} is spoken literally — so we substitute here to be bulletproof.
// Unknown names are left intact so typos surface in QA instead of vanishing.
function substituteVariables(template, vars) {
  if (template === null || template === undefined) return template;
  const str = String(template);
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const v = vars[name];
    return v === null || v === undefined ? '' : String(v);
  });
}

// Variables handed to the agent for this call. The agent's prompt / first
// message can splice any of these via {placeholder}. `slotsText` is a
// human-readable list of the next open Calendly slots so Aria can offer
// times immediately, even before it calls the get_availability tool.
function buildDynamicVariables({ lot, buyer, owner = {}, slotsText = '' }) {
  // Prefer the customer-facing marketing name; fall back to the internal name.
  const projectName = lot?.project?.marketingName || lot?.project?.name || '';
  const buyerName = buyer?.name || '';
  const firstName = buyerName.split(/\s+/)[0] || '';
  return {
    lot_id: lot?._id ? String(lot._id) : '',
    lot_number: lot?.lotNumber || '',
    project_name: projectName,
    marketing_name: projectName,
    address: lot?.address || '',
    // Homeowner / buyer we're calling
    homeowner_name: buyerName,
    buyer_name: buyerName,
    first_name: firstName,
    name: buyerName,
    buyer_email: buyer?.email || '',
    buyer_phone: buyer?.phone || '',
    // Owner / company doing the outreach
    owner_name: owner.name || '',
    agent_name: 'Aria',
    // Calendly
    calendly_url: owner.calendlyUrl || '',
    available_slots: slotsText || '',
  };
}

// POST /v1/convai/twilio/outbound-call — ElevenLabs places the call via their
// managed Twilio integration; we hand over the agent, phone-number id, the
// destination number, and per-call dynamic variables. `user_id` is set to
// `lot_<id>` so the post-call webhook can map the conversation back to the lot
// even when the agent config doesn't forward dynamic_variables.
async function startOutboundCall({ lot, buyer, owner = {}, slotsText = '', aria = {} }) {
  if (!isConfigured()) {
    const err = new Error('elevenlabs_not_configured');
    err.code = 'elevenlabs_not_configured';
    throw err;
  }
  const toNumber = normalizePhone(buyer?.phone);
  if (!toNumber) {
    const err = new Error('buyer_missing_phone');
    err.code = 'buyer_missing_phone';
    throw err;
  }
  if (!env.elevenlabs.agentId) {
    const err = new Error('agent_not_configured');
    err.code = 'agent_not_configured';
    throw err;
  }
  if (!env.elevenlabs.agentPhoneNumberId) {
    const err = new Error('agent_phone_number_not_configured');
    err.code = 'agent_phone_number_not_configured';
    throw err;
  }

  const dynamicVars = buildDynamicVariables({ lot, buyer, owner, slotsText });
  const payload = {
    agent_id: env.elevenlabs.agentId,
    agent_phone_number_id: env.elevenlabs.agentPhoneNumberId,
    to_number: toNumber,
    conversation_initiation_client_data: {
      user_id: `lot_${lot._id}`,
      dynamic_variables: dynamicVars,
    },
  };

  // Optional per-deployment prompt / first-message overrides (Settings → Aria).
  // Substituted server-side so the operator can write {first_name} etc. without
  // wiring each variable into the agent.
  const agentOverride = {};
  if (aria.systemPrompt && String(aria.systemPrompt).trim()) {
    agentOverride.prompt = { prompt: substituteVariables(aria.systemPrompt, dynamicVars) };
  }
  if (aria.firstMessage && String(aria.firstMessage).trim()) {
    agentOverride.first_message = substituteVariables(aria.firstMessage, dynamicVars);
  }
  if (Object.keys(agentOverride).length > 0) {
    payload.conversation_initiation_client_data.conversation_config_override = {
      agent: agentOverride,
    };
  }

  const c = client();
  const { data } = await c.post('/convai/twilio/outbound-call', payload);
  return data; // { conversation_id, callSid, ... }
}

// HMAC-SHA256 of `${timestamp}.${rawBody}` per ElevenLabs' docs.
// Header: `elevenlabs-signature: t=<unixSeconds>,v0=<hex>`
function verifyWebhookSignature({ rawBody, header, secret, toleranceSec = 30 * 60 }) {
  if (!secret) return { ok: true, reason: 'no_secret_configured' };
  if (!header) return { ok: false, reason: 'missing_signature' };
  const parts = String(header).split(',').reduce((acc, p) => {
    const [k, v] = p.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const timestamp = Number(parts.t);
  const provided = parts.v0;
  if (!timestamp || !provided) return { ok: false, reason: 'malformed_signature' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) return { ok: false, reason: 'stale_timestamp' };
  const computed = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  let a;
  let b;
  try {
    a = Buffer.from(computed, 'hex');
    b = Buffer.from(provided, 'hex');
  } catch {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (a.length !== b.length) return { ok: false, reason: 'length_mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

// Normalise an ElevenLabs post-call webhook into the fields we persist on the
// lot's `call` subdoc. Handles both post_call_transcription and
// call_initiation_failure event shapes.
function normalisePostCallPayload(payload) {
  const data = payload.data || payload;
  const dynamicVars =
    data?.conversation_initiation_client_data?.dynamic_variables ||
    data?.dynamic_variables ||
    {};
  // We set user_id: `lot_<id>` at dispatch — ElevenLabs echoes it back even
  // when the agent doesn't forward dynamic_variables, so it's the most
  // reliable place to recover the lot id.
  const userId =
    data?.conversation_initiation_client_data?.user_id ||
    data?.user_id ||
    payload.user_id ||
    '';
  const lotFromUserId = /^lot_([a-fA-F0-9]{24})$/.exec(userId)?.[1] || null;
  const lotId = dynamicVars.lot_id || data.lot_id || lotFromUserId || null;
  const conversationId =
    data.conversation_id || data.conversationId || payload.conversation_id || null;

  if (payload.type === 'call_initiation_failure') {
    return {
      lotId,
      conversationId,
      status: 'failed',
      durationSec: 0,
      summary: data?.failure_reason || 'call initiation failed',
      transcript: '',
      recordingUrl: null,
      outcome: 'failed',
      dataCollection: {},
      raw: payload,
    };
  }

  const analysis = data.analysis || {};
  const metadata = data.metadata || {};
  const transcriptArr = Array.isArray(data.transcript) ? data.transcript : [];
  const fullTranscript = transcriptArr
    .map((t) => `${t.role || 'agent'}: ${t.message || t.text || ''}`)
    .join('\n')
    .trim();

  const summary = analysis.transcript_summary || data.summary || '';
  const duration = Number(metadata.call_duration_secs ?? data.call_duration_secs ?? 0) || 0;
  const voicemailDetected = !!(analysis.voicemail_detected || analysis.voicemail);
  const dataStatus = String(data.status || metadata.status || '').toLowerCase();

  const recordingUrl =
    data.recording_url ||
    data.recordingUrl ||
    metadata.recording_url ||
    metadata.recordingUrl ||
    data?.media?.recording_url ||
    analysis.recording_url ||
    null;

  // Structured fields ElevenLabs extracted (each { value, rationale } or a
  // bare value). Skip nulls / empty strings.
  const dcRaw =
    analysis.data_collection_results ||
    analysis.dataCollectionResults ||
    data.data_collection_results ||
    {};
  const dataCollection = {};
  for (const [key, rawVal] of Object.entries(dcRaw)) {
    const value = rawVal && typeof rawVal === 'object' && 'value' in rawVal ? rawVal.value : rawVal;
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (!str || str.toLowerCase() === 'null') continue;
    dataCollection[key] = str;
  }

  // 'done'/'completed' fires whenever the session ends — even on calls that
  // rang out unanswered (duration 0). So a completed status only counts as a
  // real conversation when the call had non-zero duration.
  let status;
  if (voicemailDetected) status = 'voicemail';
  else if (['failed', 'cancelled', 'busy', 'error'].includes(dataStatus)) status = 'failed';
  else if (['no-answer', 'no_answer'].includes(dataStatus)) status = 'no_answer';
  else if (duration > 0) status = 'completed';
  else status = 'no_answer';

  return {
    lotId,
    conversationId,
    status,
    durationSec: duration,
    summary,
    transcript: fullTranscript,
    recordingUrl,
    outcome: status,
    dataCollection,
    raw: payload,
  };
}

// Stream a finished conversation's audio from the Convai API. Most agents
// don't ship a public recording URL in the webhook; the audio lives behind
// this authenticated endpoint instead. Returns { stream, contentType,
// contentLength } — the route pipes `stream` back to the browser.
async function fetchConversationAudio(conversationId) {
  if (!conversationId) throw new Error('conversation_id_required');
  if (!isConfigured()) {
    const err = new Error('elevenlabs_not_configured');
    err.code = 'elevenlabs_not_configured';
    throw err;
  }
  const url = `${BASE}/convai/conversations/${encodeURIComponent(conversationId)}/audio`;
  const res = await axios.get(url, {
    responseType: 'stream',
    headers: { 'xi-api-key': env.elevenlabs.apiKey },
    timeout: 30_000,
    validateStatus: (s) => s < 500,
  });
  if (res.status >= 400) {
    const err = new Error(`elevenlabs_audio_${res.status}`);
    err.code = `elevenlabs_audio_${res.status}`;
    err.upstreamStatus = res.status;
    throw err;
  }
  return {
    stream: res.data,
    contentType: res.headers['content-type'] || 'audio/mpeg',
    contentLength: res.headers['content-length'] || null,
  };
}

module.exports = {
  client,
  isConfigured,
  isDispatchable,
  normalizePhone,
  substituteVariables,
  buildDynamicVariables,
  startOutboundCall,
  verifyWebhookSignature,
  normalisePostCallPayload,
  fetchConversationAudio,
};

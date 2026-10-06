const Anthropic = require('@anthropic-ai/sdk');
const env = require('../../config/env');
const Setting = require('../../models/Setting');
const secrets = require('../secrets');

// Claude Opus 5.5 for the inbox: drafting replies in the owner's voice and
// distilling a voice profile from the knowledge base. Every request:
//   - streams (drafts appear as they're written; no HTTP timeouts),
//   - sets output_config.effort explicitly (Opus 5.5 defaults to medium and
//     always thinks — effort is the only depth control),
//   - opts into server-side fallbacks ("default" routing) so a safety
//     classifier false positive on an ordinary email never becomes an error.

const MODEL = env.anthropic.model || 'claude-opus-5-5';
const MODEL_LABEL = MODEL === 'claude-opus-5-5' ? 'Claude Opus 5.5' : MODEL;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high'];

let cached = { key: '', client: null };

function getClient() {
  const key = secrets.anthropicKey();
  if (!key) return null;
  if (cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 2 }) };
  return cached.client;
}

function clientForKey(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
}

async function resolveEffort(override) {
  if (EFFORTS.includes(override)) return override;
  try {
    const s = await Setting.getSingleton();
    const e = s.integrations?.anthropic?.effort;
    if (EFFORTS.includes(e)) return e;
  } catch {
    /* default below */
  }
  return 'medium';
}

// Turn SDK errors into something an owner can act on.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key (401). Check it in Integrations → Claude.';
  if (err instanceof Anthropic.PermissionDeniedError) return `This API key can't use ${MODEL_LABEL} (403).`;
  if (err instanceof Anthropic.NotFoundError) return `Model ${MODEL} was not found for this API key (404).`;
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting this key right now — try again in a moment.';
  if (err instanceof Anthropic.BadRequestError) return `Claude refused the request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) return 'Claude is temporarily unavailable — try again shortly.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API (network).';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status || ''}: ${err.message}`.trim();
  return err?.message || 'Claude request failed.';
}

// Validate a key (the active one when omitted) without generating tokens.
async function testKey(apiKey) {
  const c = apiKey ? clientForKey(apiKey) : getClient();
  if (!c) return { ok: false, message: 'No Claude API key connected.' };
  try {
    const m = await c.models.retrieve(MODEL);
    return { ok: true, message: `Connected — ${m.display_name || MODEL_LABEL} is available on this key.` };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}

// Stream a completion. `onText(delta)` fires per text chunk; resolves with
// { text, usage, stopReason, model }. Throws an Error whose message is
// already human-readable. `signal` aborts (client went away / pressed Stop).
async function streamText({ system, messages, effort, maxTokens = 64000, onText, signal }) {
  const c = getClient();
  if (!c) {
    const e = new Error('Claude is not connected. Add your Anthropic API key in Integrations → Claude.');
    e.status = 400;
    throw e;
  }
  const stream = c.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: await resolveEffort(effort) },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    },
    { signal }
  );
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && onText) {
        onText(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      const e = new Error('Claude declined to draft this one. Try rephrasing your instructions.');
      e.status = 422;
      throw e;
    }
    const text = final.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      stopReason: final.stop_reason,
      model: final.model,
      usage: {
        input: final.usage?.input_tokens || 0,
        output: final.usage?.output_tokens || 0,
        cacheRead: final.usage?.cache_read_input_tokens || 0,
        cacheWrite: final.usage?.cache_creation_input_tokens || 0,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
      const e = new Error('aborted');
      e.aborted = true;
      throw e;
    }
    if (err.status && !(err instanceof Anthropic.APIError)) throw err;
    const e = new Error(describeError(err));
    e.status = err.status || 502;
    throw e;
  }
}

module.exports = { MODEL, MODEL_LABEL, EFFORTS, getClient, testKey, streamText, resolveEffort, describeError };

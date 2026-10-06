const KnowledgeEntry = require('../../models/KnowledgeEntry');
const EmailThread = require('../../models/EmailThread');
const EmailMessage = require('../../models/EmailMessage');
const MailAccount = require('../../models/MailAccount');
const Setting = require('../../models/Setting');
require('../../models/Lot');
require('../../models/Project');
const { resolveScheduleTimezone } = require('../sendWindow');
const { resolveEventTypeUri, listEventTypes } = require('../calendly');
const { availableTimesInRange } = require('../calendlyConnect');
const secrets = require('../secrets');
const { selfEmailsOf } = require('../mail/store');
const { normalizeEmail, stripQuoted } = require('../mail/text');
const claude = require('./claude');
const P = require('./prompts');

// Assembles a drafting request (knowledge base + thread + optional Calendly
// times) and streams Claude's draft back through `emit`.

async function writerProfile() {
  const s = await Setting.getSingleton();
  return {
    writerName: s.inbox?.writerName || s.owner?.name || '',
    writerRole: s.inbox?.writerRole || '',
    signOff: s.inbox?.signOff || '',
    timeZone: resolveScheduleTimezone(s),
    defaultEventTypeUri: s.integrations?.calendly?.defaultEventTypeUri || '',
  };
}

async function systemBlocks(profile) {
  const entries = await KnowledgeEntry.find({ enabled: true }).lean();
  const kb = P.buildKnowledgeBlock(entries);
  return {
    entries: entries.length,
    kbTokens: P.estimateTokens(kb),
    system: [
      { type: 'text', text: P.buildSystemPrompt(profile) },
      // The knowledge base is the big, stable part — cache it.
      { type: 'text', text: kb, cache_control: { type: 'ephemeral' } },
    ],
  };
}

// Up to `max` open times over the next ~10 days, at most two per day, so the
// draft can offer a spread of options.
async function availabilityFor({ eventTypeUri, timeZone, max = 8 }) {
  if (!secrets.calendlyConfigured()) return null;
  const uri = eventTypeUri || (await resolveEventTypeUri());
  if (!uri) return null;
  const r = await availableTimesInRange({
    eventTypeUri: uri,
    start: Date.now(),
    end: Date.now() + 10 * 864e5,
    timeZone,
  });
  if (!r.ok || !r.slots.length) return null;
  const perDay = new Map();
  const picked = [];
  for (const s of r.slots) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(s.startTime));
    const n = perDay.get(day) || 0;
    if (n >= 2) continue;
    perDay.set(day, n + 1);
    picked.push(s);
    if (picked.length >= max) break;
  }
  let eventName = '';
  let bookingUrl = '';
  try {
    const types = await listEventTypes();
    const et = (types.eventTypes || []).find((t) => t.uri === uri);
    eventName = et ? `${et.name}${et.duration ? ` (${et.duration} min)` : ''}` : '';
    bookingUrl = et?.schedulingUrl || '';
  } catch {
    /* names are optional */
  }
  return { slots: picked, timeZone, eventName, bookingUrl };
}

function lotForPrompt(lot) {
  if (!lot) return null;
  return {
    lotNumber: lot.lotNumber,
    address: lot.address,
    status: lot.status,
    project: lot.project ? { name: lot.project.marketingName || lot.project.name } : null,
    buyers: lot.buyers || [],
    appointment: lot.calendlyEvent?.startTime ? { startTime: lot.calendlyEvent.startTime } : null,
  };
}

// opts: { threadId, mode, instructions, intent, tone, length,
//         includeAvailability, eventTypeUri, currentDraft, to, subject,
//         incoming, accountId }
async function streamDraft(opts, { emit, signal }) {
  const profile = await writerProfile();
  const { system, entries, kbTokens } = await systemBlocks(profile);
  const tz = profile.timeZone;
  const today = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());

  let transcript = '';
  let subject = opts.subject || '';
  let recipients = Array.isArray(opts.to) ? opts.to : [];
  let lot = null;
  let mailbox = '';

  if (opts.threadId) {
    const thread = await EmailThread.findById(opts.threadId).populate({ path: 'lot', populate: { path: 'project', select: 'name marketingName' } });
    if (!thread) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    const account = await MailAccount.findById(thread.account);
    const messages = await EmailMessage.find({ thread: thread._id }).sort({ date: 1 }).select('from to direction date text subject').lean();
    const self = account ? selfEmailsOf(account) : new Set();
    transcript = P.buildThreadTranscript(messages, { selfEmails: self, timeZone: tz });
    subject = subject || thread.subject;
    lot = lotForPrompt(thread.lot);
    mailbox = account ? `${account.displayName ? `${account.displayName} ` : ''}<${account.email}>` : '';
    if (!recipients.length) {
      const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
      if (lastIn?.from?.email && !self.has(normalizeEmail(lastIn.from.email))) recipients = [lastIn.from];
    }
  } else if (opts.accountId) {
    const account = await MailAccount.findById(opts.accountId).lean();
    if (account) mailbox = `${account.displayName ? `${account.displayName} ` : ''}<${account.email}>`;
  }

  let availability = null;
  if (opts.includeAvailability) {
    availability = await availabilityFor({ eventTypeUri: opts.eventTypeUri || profile.defaultEventTypeUri, timeZone: tz }).catch(() => null);
  }

  emit({
    type: 'meta',
    model: claude.MODEL_LABEL,
    knowledgeEntries: entries,
    knowledgeTokens: kbTokens,
    availability: availability ? availability.slots.length : 0,
  });

  const userText = P.buildDraftRequest({
    mode: opts.mode,
    transcript,
    incoming: opts.incoming || '',
    subject,
    recipients,
    lot,
    availability,
    instructions: String(opts.instructions || '').slice(0, 2000),
    intent: String(opts.intent || '').slice(0, 300),
    tone: opts.tone,
    length: opts.length,
    currentDraft: String(opts.currentDraft || '').slice(0, 20000),
    today,
    mailbox,
  });

  // New emails start with "Subject: …" — peel it off the stream so the
  // client can fill the subject field and the editor separately.
  const wantsSubject = opts.mode === 'new';
  let head = '';
  let headDone = !wantsSubject;
  const onText = (delta) => {
    if (headDone) return emit({ type: 'text', text: delta });
    head += delta;
    const nl = head.indexOf('\n');
    if (nl === -1 && head.length < 200) return undefined;
    headDone = true;
    const m = head.match(/^\s*Subject:\s*(.+?)\s*(?:\n|$)([\s\S]*)$/i);
    if (m) {
      emit({ type: 'subject', subject: m[1].trim() });
      const rest = m[2].replace(/^\s*\n/, '');
      if (rest) emit({ type: 'text', text: rest });
    } else {
      emit({ type: 'text', text: head });
    }
    return undefined;
  };

  const result = await claude.streamText({
    system,
    messages: [{ role: 'user', content: userText }],
    effort: opts.effort,
    onText,
    signal,
  });
  if (!headDone && head) onText('\n');
  const split = wantsSubject ? P.splitSubject(result.text) : { subject: '', body: result.text.trim() };
  emit({ type: 'done', body: split.body, subject: split.subject, usage: result.usage, model: result.model });
}

// Distil a voice profile from the knowledge base examples / saved threads and
// the owner's recent sent mail, and save it as a style entry.
async function streamStyleProfile({ emit, signal }) {
  const samples = [];
  const kb = await KnowledgeEntry.find({ type: { $in: ['example', 'thread'] }, enabled: true }).sort({ createdAt: -1 }).limit(25).lean();
  for (const e of kb) {
    if (e.type === 'example') samples.push({ source: `example: ${e.title}`, text: e.content });
    else {
      // Only the owner's own turns from saved conversations.
      const mine = String(e.content)
        .split(/\n(?=--- )/)
        .filter((chunk) => chunk.startsWith('--- ME'))
        .map((chunk) => chunk.replace(/^--- ME[^\n]*\n/, ''))
        .join('\n\n');
      if (mine.trim()) samples.push({ source: `saved conversation: ${e.title}`, text: mine });
    }
  }
  const sent = await EmailMessage.find({ direction: 'out', text: { $ne: '' } }).sort({ date: -1 }).limit(30).select('text subject').lean();
  for (const m of sent) {
    const t = stripQuoted(m.text);
    if (t.length > 40) samples.push({ source: `sent: ${m.subject || ''}`, text: t });
  }
  if (samples.length < 2) {
    throw Object.assign(
      new Error('Add at least two example emails or saved conversations (or send a few emails from the inbox) so there is something to learn from.'),
      { status: 400 }
    );
  }
  emit({ type: 'meta', model: claude.MODEL_LABEL, samples: samples.length });
  const result = await claude.streamText({
    system: 'You are an expert editor who profiles writing styles precisely and concisely.',
    messages: [{ role: 'user', content: P.buildStyleRequest(samples.slice(0, 40)) }],
    effort: 'medium',
    onText: (t) => emit({ type: 'text', text: t }),
    signal,
  });
  const content = result.text.trim();
  let entry = await KnowledgeEntry.findOne({ type: 'style', 'source.generated': true });
  if (!entry) entry = new KnowledgeEntry({ type: 'style', source: { generated: true }, pinned: true });
  entry.title = 'Voice profile (learned by Claude)';
  entry.content = content;
  entry.enabled = true;
  entry.source.messageCount = samples.length;
  await entry.save();
  emit({ type: 'done', entryId: entry._id, usage: result.usage });
}

module.exports = { streamDraft, streamStyleProfile, writerProfile, availabilityFor };
